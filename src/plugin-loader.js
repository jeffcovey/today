// Plugin loader - discovers and manages plugins
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parse as parseToml } from 'smol-toml';
import { getFullConfig } from './config.js';
import { validateEntries } from './plugin-schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'plugins');

// Cache of loaded plugins
const pluginCache = new Map();

/**
 * Discover all available plugins in the plugins directory
 * Reads plugin.toml from each subdirectory
 * @returns {Promise<Map<string, object>>} Map of plugin name to plugin metadata
 */
export async function discoverPlugins() {
  if (pluginCache.size > 0) {
    return pluginCache;
  }

  if (!fs.existsSync(PLUGINS_DIR)) {
    return pluginCache;
  }

  const pluginDirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dir of pluginDirs) {
    const pluginPath = path.join(PLUGINS_DIR, dir);
    const tomlPath = path.join(pluginPath, 'plugin.toml');

    if (!fs.existsSync(tomlPath)) {
      continue;
    }

    try {
      const tomlContent = fs.readFileSync(tomlPath, 'utf8');
      const plugin = parseToml(tomlContent);
      plugin._path = pluginPath;

      if (plugin.name) {
        pluginCache.set(plugin.name, plugin);
      }
    } catch (error) {
      console.error(`Failed to load plugin ${dir}:`, error.message);
    }
  }

  return pluginCache;
}

/**
 * Get configured sources for a plugin from config.toml
 * Returns array of { sourceName, config } for enabled sources
 * @param {string} pluginName
 * @returns {Array<{sourceName: string, config: object}>}
 */
export function getPluginSources(pluginName) {
  const config = getFullConfig();
  const pluginConfig = config.plugins?.[pluginName];

  if (!pluginConfig) {
    return [];
  }

  const sources = [];

  for (const [sourceName, sourceConfig] of Object.entries(pluginConfig)) {
    // Only include if explicitly enabled
    if (sourceConfig.enabled !== true) {
      continue;
    }

    sources.push({
      sourceName,
      config: sourceConfig
    });
  }

  return sources;
}

/**
 * Get a specific plugin by name
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function getPlugin(name) {
  const plugins = await discoverPlugins();
  return plugins.get(name) || null;
}

/**
 * Get all enabled plugins with their sources
 * @returns {Promise<Array<{plugin: object, sources: Array}>>}
 */
export async function getEnabledPlugins() {
  const plugins = await discoverPlugins();
  const enabled = [];

  for (const [name, plugin] of plugins) {
    const sources = getPluginSources(name);

    if (sources.length > 0) {
      enabled.push({ plugin, sources });
    }
  }

  return enabled;
}

/**
 * Check if a plugin is configured (has at least one enabled source)
 * @param {string} pluginName
 * @returns {boolean}
 */
export function isPluginConfigured(pluginName) {
  return getPluginSources(pluginName).length > 0;
}

/**
 * Run a plugin command (e.g., sync) and return parsed JSON output
 * @param {object} plugin - Plugin metadata from plugin.toml
 * @param {string} command - Command name (e.g., 'sync')
 * @param {object} sourceConfig - Source configuration from config.toml
 * @returns {{success: boolean, data?: any, error?: string}}
 */
function runPluginCommand(plugin, command, sourceConfig) {
  const commandPath = plugin.commands?.[command];
  if (!commandPath) {
    return { success: false, error: `Plugin ${plugin.name} has no '${command}' command` };
  }

  const fullPath = path.join(plugin._path, commandPath);
  if (!fs.existsSync(fullPath)) {
    return { success: false, error: `Command not found: ${fullPath}` };
  }

  try {
    const output = execSync(fullPath, {
      cwd: plugin._path,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROJECT_ROOT,
        PLUGIN_CONFIG: JSON.stringify(sourceConfig)
      },
      maxBuffer: 50 * 1024 * 1024 // 50MB for large syncs
    });

    const data = JSON.parse(output);
    return { success: true, data };
  } catch (error) {
    const message = error.stderr || error.message;
    return { success: false, error: message };
  }
}

/**
 * Run sync for a specific plugin and source
 * @param {object} plugin
 * @param {string} sourceName
 * @param {object} sourceConfig
 * @param {object} context - { db, vaultPath }
 * @returns {Promise<{success: boolean, count: number, message: string}>}
 */
export async function syncPluginSource(plugin, sourceName, sourceConfig, context) {
  const { db } = context;
  // Source identifier for the `source` column (e.g., "markdown-time-tracking/default")
  const sourceId = `${plugin.name}/${sourceName}`;

  // Run the sync command
  const result = runPluginCommand(plugin, 'sync', sourceConfig);

  if (!result.success) {
    return {
      success: false,
      count: 0,
      message: `Error syncing ${sourceId}: ${result.error}`
    };
  }

  const entries = result.data;
  if (!Array.isArray(entries)) {
    return {
      success: false,
      count: 0,
      message: `Plugin ${plugin.name} sync did not return an array`
    };
  }

  // Validate entries against schema
  const validation = validateEntries(plugin.type, entries, {
    pluginName: sourceId,
    logger: console
  });

  if (!validation.valid) {
    return {
      success: false,
      count: 0,
      message: `Plugin ${sourceId} returned invalid data (${validation.errors.length} errors)`
    };
  }

  // Get the standardized table name for this plugin type
  const tableName = getTableNameForType(plugin.type);
  if (!tableName) {
    return {
      success: false,
      count: 0,
      message: `Unknown plugin type: ${plugin.type}`
    };
  }

  // Insert entries with source identifier
  const count = insertEntries(db, tableName, plugin.type, entries, sourceId);

  return {
    success: true,
    count,
    message: `Synced ${count} entries from ${sourceId}`
  };
}

/**
 * Map plugin types to their standardized table names
 * Tables are created by migrations, not by plugins
 */
const TYPE_TO_TABLE = {
  'time-logs': 'time_logs',
  // Add other types as migrations are created:
  // 'tasks': 'tasks',
  // 'events': 'events',
  // 'email': 'email',
  // 'people': 'people',
  // 'habits': 'habits',
  // 'diary': 'diary',
};

/**
 * Get the standardized table name for a plugin type
 */
function getTableNameForType(pluginType) {
  return TYPE_TO_TABLE[pluginType] || null;
}

/**
 * Insert entries into the standardized type table
 * @param {object} db - Database connection
 * @param {string} tableName - Standardized table name
 * @param {string} pluginType - Plugin type
 * @param {Array} entries - Entries to insert
 * @param {string} sourceId - Source identifier (e.g., "markdown-time-tracking/default")
 * @returns {number} Number of entries inserted
 */
function insertEntries(db, tableName, pluginType, entries, sourceId) {
  if (pluginType === 'time-logs') {
    // Clear existing entries for this source before inserting
    db.prepare(`DELETE FROM ${tableName} WHERE source = ?`).run(sourceId);

    const insert = db.prepare(`
      INSERT OR REPLACE INTO ${tableName}
      (id, source, start_time, end_time, duration_minutes, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertAll = db.transaction(() => {
      for (const entry of entries) {
        // Generate ID from source + start_time for uniqueness
        const id = entry.id || `${sourceId}:${entry.start_time}`;
        insert.run(
          id,
          sourceId,
          entry.start_time,
          entry.end_time || null,
          entry.duration_minutes || 0,
          entry.description || null
        );
      }
    });

    insertAll();
    return entries.length;
  }

  // Add other plugin types as migrations are created
  return 0;
}

/**
 * Run sync for all enabled plugins
 * @param {object} context - { db, vaultPath }
 * @returns {Promise<Array<{plugin: string, source: string, result: object}>>}
 */
export async function syncAllPlugins(context) {
  const enabledPlugins = await getEnabledPlugins();
  const results = [];

  for (const { plugin, sources } of enabledPlugins) {
    for (const { sourceName, config } of sources) {
      const result = await syncPluginSource(plugin, sourceName, config, context);
      results.push({
        plugin: plugin.name,
        source: sourceName,
        result
      });
    }
  }

  return results;
}

/**
 * Get plugin data formatted for AI consumption
 * Returns enabled plugins with their AI instructions (both plugin-defined and user-defined)
 * @returns {Promise<Array<{pluginName: string, displayName: string, description: string, type: string, access: string, source: string, tableName: string|null, pluginAiInstructions: string|null, userAiInstructions: string|null, config: object}>>}
 */
export async function getPluginDataForAI() {
  const enabledPlugins = await getEnabledPlugins();
  const result = [];

  for (const { plugin, sources } of enabledPlugins) {
    for (const { sourceName, config } of sources) {
      const tableName = plugin.commands?.sync
        ? `${plugin.name.replace(/-/g, '_')}_${sourceName.replace(/-/g, '_')}`
        : null;

      // Build config values: plugin settings defaults, then user overrides
      const settingsDefaults = {};
      if (plugin.settings) {
        for (const [key, def] of Object.entries(plugin.settings)) {
          if (def.default !== undefined) {
            settingsDefaults[key] = def.default;
          }
        }
      }
      const mergedConfig = { ...settingsDefaults, ...config };

      // Interpolate {variable} placeholders in aiInstructions with config values
      let aiInstructions = plugin.aiInstructions || null;
      if (aiInstructions) {
        aiInstructions = aiInstructions.replace(/\{(\w+)\}/g, (match, key) => {
          return mergedConfig[key] !== undefined ? mergedConfig[key] : match;
        });
      }

      result.push({
        pluginName: plugin.name,
        displayName: plugin.displayName || plugin.name,
        description: plugin.description,
        type: plugin.type,
        access: plugin.access,
        source: sourceName,
        tableName,
        // Plugin's instructions for AI (from plugin.toml), with config values interpolated
        pluginAiInstructions: aiInstructions,
        // User's custom instructions (from config.toml)
        userAiInstructions: config.ai_instructions || null,
        config: {
          // Include non-sensitive config fields for context
          ...Object.fromEntries(
            Object.entries(config).filter(([key]) =>
              !['enabled', 'ai_instructions'].includes(key) &&
              !key.toLowerCase().includes('token') &&
              !key.toLowerCase().includes('secret') &&
              !key.toLowerCase().includes('password')
            )
          )
        }
      });
    }
  }

  return result;
}

/**
 * Get all available plugins' AI instructions (even if not configured)
 * This tells the AI about all data sources it could potentially access
 * @returns {Promise<Array<{pluginName: string, displayName: string, description: string, aiInstructions: string|null}>>}
 */
export async function getAllPluginAiInstructions() {
  const plugins = await discoverPlugins();
  const result = [];

  for (const [name, plugin] of plugins) {
    result.push({
      pluginName: name,
      displayName: plugin.displayName || name,
      description: plugin.description,
      type: plugin.type,
      access: plugin.access,
      aiInstructions: plugin.aiInstructions || null
    });
  }

  return result;
}
