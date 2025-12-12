// Plugin loader - discovers and manages plugins
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parse as parseToml } from 'smol-toml';
import { getFullConfig } from './config.js';
import { validateEntries, getTableName, schemas } from './plugin-schemas.js';
import { runAutoTagger, createFileBasedUpdater } from './auto-tagger.js';

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
 * Derive plugin access level from its commands
 * @param {object} plugin - Plugin object with commands
 * @returns {'read-only'|'read-write'|'none'}
 */
export function getPluginAccess(plugin) {
  const hasRead = !!plugin.commands?.read;
  const hasWrite = !!plugin.commands?.write;

  if (hasRead && hasWrite) return 'read-write';
  if (hasRead) return 'read-only';
  if (hasWrite) return 'write-only';
  return 'none';
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
 * Run a plugin command (e.g., read, write) and return parsed JSON output
 * @param {object} plugin - Plugin metadata from plugin.toml
 * @param {string} command - Command name (e.g., 'read', 'write')
 * @param {object} sourceConfig - Source configuration from config.toml
 * @param {object} extraEnv - Additional environment variables
 * @returns {{success: boolean, data?: any, error?: string}}
 */
function runPluginCommand(plugin, command, sourceConfig, extraEnv = {}) {
  const commandPath = plugin.commands?.[command];
  if (!commandPath) {
    return { success: false, error: `Plugin ${plugin.name} has no '${command}' command` };
  }

  const fullPath = path.join(plugin._path, commandPath);
  if (!fs.existsSync(fullPath)) {
    return { success: false, error: `Command not found: ${fullPath}` };
  }

  try {
    // Run from project root so relative paths in plugins work correctly
    const output = execSync(fullPath, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROJECT_ROOT,
        PLUGIN_CONFIG: JSON.stringify(sourceConfig),
        ...extraEnv
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
 * Get last sync metadata for a source
 */
export function getSyncMetadata(db, sourceId) {
  try {
    return db.prepare('SELECT * FROM sync_metadata WHERE source = ?').get(sourceId);
  } catch {
    // Table might not exist yet
    return null;
  }
}

/**
 * Get the most recent sync time for a plugin type
 * @param {object} db - Database instance
 * @param {string} pluginType - Plugin type (e.g., 'events', 'time-logs')
 * @returns {Date|null} - Most recent sync time, or null if never synced
 */
export function getLatestSyncTimeForType(db, pluginType) {
  try {
    // Get the table name for this plugin type
    const tableName = getTableName(pluginType);
    if (!tableName) return null;

    // Get the latest sync time for sources that have entries in the target table
    const latestResult = db.prepare(`
      SELECT sm.last_synced_at
      FROM sync_metadata sm
      WHERE EXISTS (SELECT 1 FROM ${tableName} e WHERE e.source = sm.source)
      ORDER BY sm.last_synced_at DESC
      LIMIT 1
    `).get();

    return latestResult ? new Date(latestResult.last_synced_at + 'Z') : null;
  } catch {
    return null;
  }
}

/**
 * Update sync metadata after a successful sync
 */
function updateSyncMetadata(db, sourceId, filesProcessed, entriesCount) {
  db.prepare(`
    INSERT OR REPLACE INTO sync_metadata (source, last_synced_at, last_sync_files, entries_count)
    VALUES (?, datetime('now'), ?, ?)
  `).run(sourceId, JSON.stringify(filesProcessed), entriesCount);
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

  // Get last sync time to enable incremental sync
  const syncMeta = getSyncMetadata(db, sourceId);
  const lastSyncTime = syncMeta?.last_synced_at || null;

  // Run the read command with last sync time and source ID
  const result = runPluginCommand(plugin, 'read', sourceConfig, {
    LAST_SYNC_TIME: lastSyncTime || '',
    SOURCE_ID: sourceId
  });

  if (!result.success) {
    return {
      success: false,
      count: 0,
      message: `Error syncing ${sourceId}: ${result.error}`
    };
  }

  // Utility plugins don't store data - just run and report results
  if (plugin.type === 'utility') {
    const data = result.data || {};
    return {
      success: true,
      count: data.cleaned || 0,
      message: data.message || `Utility plugin completed (${data.cleaned || 0} items processed)`
    };
  }

  // Context plugins provide ephemeral data - no database storage
  if (plugin.type === 'context') {
    const data = result.data || {};
    const count = data.count || (Array.isArray(data.files) ? data.files.length : 0);
    return {
      success: true,
      count,
      message: data.message || `${count} item(s) available`
    };
  }

  // Plugin can return either:
  // - Array of entries (legacy full sync)
  // - Object with { entries: [], files_processed: [], incremental: true }
  let entries;
  let filesProcessed = null;
  let isIncremental = false;

  if (Array.isArray(result.data)) {
    entries = result.data;
  } else if (result.data && Array.isArray(result.data.entries)) {
    entries = result.data.entries;
    filesProcessed = result.data.files_processed || null;
    isIncremental = result.data.incremental === true;
  } else {
    return {
      success: false,
      count: 0,
      message: `Plugin ${plugin.name} sync did not return valid data`
    };
  }

  // If no entries and incremental, nothing changed
  if (entries.length === 0 && isIncremental) {
    return {
      success: true,
      count: 0,
      message: `No changes since last sync`
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
  const count = insertEntries(db, tableName, plugin.type, entries, sourceId, filesProcessed);

  // Update sync metadata
  updateSyncMetadata(db, sourceId, filesProcessed || [], count);

  // Run auto-tagger if enabled (never fails the sync)
  let taggingResult = null;
  const taggableField = sourceConfig.taggable_field || plugin.settings?.taggable_field?.default;
  if (sourceConfig.auto_add_topics && taggableField && getPluginAccess(plugin) === 'read-write') {
    try {
      const updater = createFileBasedUpdater(PROJECT_ROOT);
      taggingResult = await runAutoTagger({
        db,
        plugin,
        sourceName,
        sourceConfig,
        tableName,
        taggableField,
        updateEntry: (id, newValue) => updater.update(id, newValue)
      });

      // Flush any file changes
      updater.flush();

      // If we tagged entries, read again to update database
      if (taggingResult.tagged > 0) {
        const resyncResult = runPluginCommand(plugin, 'read', sourceConfig, {
          LAST_SYNC_TIME: '', // Force full re-read of modified files
          SOURCE_ID: sourceId
        });
        if (resyncResult.success && resyncResult.data) {
          const resyncEntries = Array.isArray(resyncResult.data)
            ? resyncResult.data
            : resyncResult.data.entries || [];
          const resyncFiles = resyncResult.data.files_processed || null;
          insertEntries(db, tableName, plugin.type, resyncEntries, sourceId, resyncFiles);
        }
      }
    } catch (error) {
      // Log but never fail sync due to tagging
      console.warn(`Warning: Auto-tagging failed for ${sourceId}: ${error.message}`);
    }
  }

  const incrementalMsg = isIncremental ? ' (incremental)' : '';
  const taggingMsg = taggingResult?.tagged ? `, tagged ${taggingResult.tagged}` : '';
  return {
    success: true,
    count,
    message: `Synced ${count} entries from ${sourceId}${incrementalMsg}${taggingMsg}`
  };
}

/**
 * Get the standardized table name for a plugin type
 * Uses the schema definitions as the single source of truth
 */
function getTableNameForType(pluginType) {
  return getTableName(pluginType);
}

/**
 * Insert entries into the standardized type table
 * @param {object} db - Database connection
 * @param {string} tableName - Standardized table name
 * @param {string} pluginType - Plugin type
 * @param {Array} entries - Entries to insert
 * @param {string} sourceId - Source identifier (e.g., "markdown-time-tracking/default")
 * @param {Array|null} filesProcessed - List of files that were processed (for incremental sync)
 * @returns {number} Number of entries inserted
 */
function insertEntries(db, tableName, pluginType, entries, sourceId, filesProcessed) {
  const schema = schemas[pluginType];
  if (!schema || !schema.fields) {
    return 0;
  }

  // Handle deletion strategy based on plugin type and incremental sync
  if (pluginType === 'time-logs' && filesProcessed && filesProcessed.length > 0) {
    // For time-logs incremental sync, only delete entries from re-processed files
    const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE source = ? AND id LIKE ?`);
    for (const file of filesProcessed) {
      deleteStmt.run(sourceId, `${sourceId}:${file}:%`);
    }
  } else if (!filesProcessed || pluginType === 'events') {
    // Full sync: delete all entries for this source
    db.prepare(`DELETE FROM ${tableName} WHERE source = ?`).run(sourceId);
  }
  // For diary/issues with empty filesProcessed array, nothing to delete (incremental)

  // Build column list from schema (excluding dbOnly fields like created_at, updated_at)
  const columns = [];
  const fieldNames = [];
  for (const [name, field] of Object.entries(schema.fields)) {
    if (name === 'created_at' || name === 'updated_at') continue; // Let DB handle these
    columns.push(name);
    if (!field.dbOnly) {
      fieldNames.push(name);
    }
  }

  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`
    INSERT OR REPLACE INTO ${tableName}
    (${columns.join(', ')})
    VALUES (${placeholders})
  `);

  // Determine which field to use for generating IDs if not provided
  const idFallbackField = schema.fields.start_time ? 'start_time'
    : schema.fields.date ? 'date'
    : schema.fields.start_date ? 'start_date'
    : null;

  const insertAll = db.transaction(() => {
    for (const entry of entries) {
      // Generate ID: use plugin-provided ID or generate from source + fallback field
      let id;
      if (entry.id) {
        id = `${sourceId}:${entry.id}`;
      } else if (idFallbackField && entry[idFallbackField]) {
        // For events, include title in ID for uniqueness
        if (pluginType === 'events' && entry.title) {
          id = `${sourceId}:${entry[idFallbackField]}:${entry.title}`;
        } else {
          id = `${sourceId}:${entry[idFallbackField]}`;
        }
      } else {
        id = `${sourceId}:${Date.now()}`;
      }

      // Build values array matching column order
      const values = columns.map(col => {
        if (col === 'id') return id;
        if (col === 'source') return sourceId;

        const value = entry[col];
        const field = schema.fields[col];

        // Handle null/undefined
        if (value === undefined || value === null) {
          return field?.required ? '' : null;
        }

        // Handle boolean -> integer conversion for SQLite
        if (field?.jsType === 'boolean') {
          return value ? 1 : 0;
        }

        return value;
      });

      insert.run(...values);
    }
  });

  insertAll();
  return entries.length;
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
      const tableName = plugin.commands?.read
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
        access: getPluginAccess(plugin),
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
      access: getPluginAccess(plugin),
      aiInstructions: plugin.aiInstructions || null
    });
  }

  return result;
}

/**
 * Get enabled sources for a plugin type, optionally filtered by a search pattern
 * Returns sources matching the filter, or all sources if no filter provided
 * @param {string} pluginType - Plugin type (e.g., 'time-logs')
 * @param {string|null} sourceFilter - Optional filter pattern (matches against source IDs)
 * @returns {Promise<{sources: Array<{sourceId: string, plugin: object, sourceName: string, config: object}>, allSources: Array<{sourceId: string, enabled: boolean}>}>}
 */
export async function getSourcesForType(pluginType, sourceFilter = null) {
  const plugins = await discoverPlugins();
  const allSources = [];
  const matchingSources = [];

  for (const [name, plugin] of plugins) {
    if (plugin.type !== pluginType) continue;

    const sources = getPluginSources(name);

    // Track all sources for this type (enabled and disabled info)
    if (sources.length > 0) {
      for (const { sourceName, config } of sources) {
        const sourceId = `${name}/${sourceName}`;
        allSources.push({ sourceId, enabled: true, pluginName: name });

        // Check if it matches the filter
        if (!sourceFilter || sourceId.includes(sourceFilter)) {
          matchingSources.push({ sourceId, plugin, sourceName, config });
        }
      }
    } else {
      // Plugin exists but has no enabled sources
      allSources.push({ sourceId: name, enabled: false, pluginName: name });
    }
  }

  return { sources: matchingSources, allSources };
}

/**
 * Write an entry using a plugin's write command
 * @param {string} pluginName - Plugin name (e.g., 'markdown-time-tracking')
 * @param {string} sourceName - Source name (e.g., 'local')
 * @param {object} entry - Entry data to write
 * @returns {Promise<{success: boolean, data?: any, error?: string}>}
 */
export async function writePluginEntry(pluginName, sourceName, entry) {
  const plugin = await getPlugin(pluginName);
  if (!plugin) {
    return { success: false, error: `Plugin not found: ${pluginName}` };
  }

  if (!plugin.commands?.write) {
    return { success: false, error: `Plugin ${pluginName} does not support writing` };
  }

  const sources = getPluginSources(pluginName);
  const source = sources.find(s => s.sourceName === sourceName);
  if (!source) {
    return { success: false, error: `Source not found: ${pluginName}/${sourceName}` };
  }

  return runPluginCommand(plugin, 'write', source.config, {
    ENTRY_JSON: JSON.stringify(entry)
  });
}

/**
 * Get writable sources for a plugin type, with validation
 * Returns the target source to write to, handling single vs multiple source cases
 * @param {string} pluginType - Plugin type (e.g., 'time-logs')
 * @param {string|null} sourceFilter - Optional source filter from --source option
 * @returns {Promise<{success: boolean, source?: object, error?: string, availableSources?: Array}>}
 */
export async function getWritableSource(pluginType, sourceFilter = null) {
  const { sources, allSources } = await getSourcesForType(pluginType);

  // Filter to sources that support writing
  const writableSources = sources.filter(s => s.plugin.commands?.write);

  if (writableSources.length === 0) {
    return {
      success: false,
      error: `No ${pluginType} plugins with write support are enabled`,
      availableSources: allSources
    };
  }

  // If source filter provided, find matching source
  if (sourceFilter) {
    const matching = writableSources.filter(s => s.sourceId.includes(sourceFilter));
    if (matching.length === 0) {
      return {
        success: false,
        error: `No writable source matching "${sourceFilter}"`,
        availableSources: writableSources.map(s => ({ sourceId: s.sourceId, enabled: true }))
      };
    }
    if (matching.length > 1) {
      return {
        success: false,
        error: `Multiple sources match "${sourceFilter}". Be more specific.`,
        availableSources: matching.map(s => ({ sourceId: s.sourceId, enabled: true }))
      };
    }
    return { success: true, source: matching[0] };
  }

  // No filter provided - require it if multiple writable sources
  if (writableSources.length > 1) {
    return {
      success: false,
      error: `Multiple ${pluginType} sources available. Use --source to specify which one.`,
      availableSources: writableSources.map(s => ({ sourceId: s.sourceId, enabled: true }))
    };
  }

  // Single writable source - use it
  return { success: true, source: writableSources[0] };
}

/**
 * Write an entry and sync the database
 * Handles source selection, writing via plugin, and syncing
 * @param {string} pluginType - Plugin type (e.g., 'time-logs')
 * @param {object} entry - Entry data to write
 * @param {object} options - { sourceFilter, db, vaultPath, onSync }
 * @returns {Promise<{success: boolean, error?: string, availableSources?: Array}>}
 */
export async function writeEntryAndSync(pluginType, entry, options = {}) {
  const { sourceFilter, db, vaultPath, onSync } = options;

  // Get target source
  const sourceResult = await getWritableSource(pluginType, sourceFilter);
  if (!sourceResult.success) {
    return sourceResult;
  }

  const { source } = sourceResult;

  // Write via plugin
  const writeResult = await writePluginEntry(source.plugin.name, source.sourceName, entry);
  if (!writeResult.success) {
    return { success: false, error: writeResult.error };
  }

  // Sync if db context provided
  if (db) {
    if (onSync) onSync();
    const context = { db, vaultPath };
    await syncPluginSource(source.plugin, source.sourceName, source.config, context);
  }

  return { success: true, source };
}

/**
 * Get aggregated AI instructions by plugin type
 * Combines user instructions from all enabled sources of each type
 * @returns {Promise<Map<string, {sources: string[], instructions: string[]}>>}
 */
export async function getAIInstructionsByType() {
  const enabledPlugins = await getEnabledPlugins();
  const byType = new Map();

  for (const { plugin, sources } of enabledPlugins) {
    const pluginType = plugin.type;
    if (!pluginType) continue;

    if (!byType.has(pluginType)) {
      byType.set(pluginType, { sources: [], instructions: [] });
    }

    const typeData = byType.get(pluginType);

    for (const { sourceName, config } of sources) {
      const sourceId = `${plugin.name}/${sourceName}`;
      typeData.sources.push(sourceId);

      // Add user's custom AI instructions if present (with source info)
      if (config.ai_instructions) {
        typeData.instructions.push({
          sourceId,
          text: config.ai_instructions.trim()
        });
      }
    }
  }

  return byType;
}
