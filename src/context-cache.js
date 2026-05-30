// Context cache: caches the "Gathering context" step so it is only recomputed
// when something has actually changed.
//
// During context gathering every plugin command runs with CONTEXT_ONLY=true,
// which skips syncing (see ensureSyncForType in plugin-loader.js) and merely
// reads the already-synced SQLite DB to format markdown. The gathered context
// is therefore a pure function of:
//   - the set of enabled plugin sources + their ai_instructions,
//   - the synced DB data (freshness tracked per-source in sync_metadata), and
//   - the current local day (output is time-relative).
// We fingerprint those cheap inputs *before* running any plugin command and
// skip the whole loop on a cache hit.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

import { getPluginTypes, getAIMetadata, generateAIContextBlock, schemas } from './plugin-schemas.js';
import { getAIInstructionsByType, getPluginSources } from './plugin-loader.js';
import { getConfigPath, getTimezone } from './config.js';
import { getTodayDate } from './date-utils.js';

// Bump when the gather logic below changes in a way that should invalidate
// every existing cache entry across an upgrade.
export const CONTEXT_CACHE_VERSION = 1;

// How many cache rows to retain (one per distinct fingerprint: live + a few
// historical-date lookups). Older rows are pruned on each write.
const MAX_CACHE_ROWS = 5;

/**
 * Snapshot the per-source sync state. This is the change signal: any sync
 * (manual or background cron) updates last_synced_at, which changes the key.
 * @param {object} db
 * @returns {Array<object>}
 */
function getSyncSnapshot(db) {
  try {
    return db.prepare(
      'SELECT source, last_synced_at, entries_count FROM sync_metadata ORDER BY source'
    ).all();
  } catch {
    // Table might not exist yet
    return [];
  }
}

/**
 * Serialize an instructionsByType Map into a stable, comparable structure.
 * Captures which sources are enabled and their user ai_instructions.
 * @param {Map} instructionsByType
 * @returns {Array}
 */
function serializeInstructions(instructionsByType) {
  const out = [];
  for (const [type, data] of instructionsByType.entries()) {
    out.push([
      type,
      [...(data.sources || [])].sort(),
      (data.instructions || [])
        .map(i => [i.sourceId, i.text])
        .sort((a, b) => a[0].localeCompare(b[0]))
    ]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

function stableSortObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableSortObject(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Snapshot enabled source configs used by context gathering.
 * Captures config-only changes that should invalidate cached context.
 * @param {Map} instructionsByType
 * @returns {Array}
 */
function serializeSourceConfigs(instructionsByType) {
  const sourceIds = new Set();
  for (const data of instructionsByType.values()) {
    for (const sourceId of (data.sources || [])) {
      sourceIds.add(sourceId);
    }
  }

  const serialized = [];
  for (const sourceId of sourceIds) {
    const [pluginName, sourceName] = sourceId.split('/');
    let config = null;
    try {
      const sources = getPluginSources(pluginName);
      config = sources.find(s => s.sourceName === sourceName)?.config ?? null;
    } catch {
      config = null;
    }
    serialized.push([sourceId, stableSortObject(config)]);
  }

  serialized.sort((a, b) => a[0].localeCompare(b[0]));
  return serialized;
}

/**
 * Compute the cache key for the current context. All inputs are cheap (a config
 * read plus one indexed query) — no plugin commands run.
 * @param {object} params
 * @param {object} params.db - Database instance
 * @param {Map} params.instructionsByType - From getAIInstructionsByType()
 * @param {string} params.dayKey - Local day, YYYY-MM-DD
 * @param {string|null} [params.targetDate] - Historical date, if any
 * @returns {string} sha256 hex digest
 */
export function computeContextCacheKey({ db, instructionsByType, dayKey, targetDate = null }) {
  const fingerprint = {
    version: CONTEXT_CACHE_VERSION,
    targetDate: targetDate || null,
    dayKey,
    instructions: serializeInstructions(instructionsByType),
    sourceConfigs: serializeSourceConfigs(instructionsByType),
    sync: getSyncSnapshot(db)
  };
  return crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}

/**
 * Look up cached content by key.
 * @returns {string|null}
 */
export function getCachedContext(db, key) {
  try {
    const row = db.prepare('SELECT content FROM context_cache WHERE cache_key = ?').get(key);
    return row ? row.content : null;
  } catch {
    return null;
  }
}

/**
 * Store cached content, then prune to the newest MAX_CACHE_ROWS entries.
 */
export function setCachedContext(db, key, content) {
  try {
    db.prepare(`
      INSERT INTO context_cache (cache_key, content, created_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(cache_key) DO UPDATE SET content = excluded.content, created_at = CURRENT_TIMESTAMP
    `).run(key, content);

    db.prepare(`
      DELETE FROM context_cache
      WHERE cache_key NOT IN (
        SELECT cache_key FROM context_cache ORDER BY created_at DESC, cache_key LIMIT ?
      )
    `).run(MAX_CACHE_ROWS);
  } catch {
    // Caching is best-effort; never break the caller.
  }
}

/**
 * Gather contextual data from the "context" plugin type (read.js sources).
 * Moved verbatim from bin/today.
 */
async function getContextPluginsData(typeData, projectRoot) {
  if (!typeData || typeData.sources.length === 0) return null;

  const lines = ['## Contextual Information', ''];

  // Include user ai_instructions for context plugins
  if (typeData.instructions && typeData.instructions.length > 0) {
    lines.push('**Specific instructions from the user:**');
    for (const { sourceId, text } of typeData.instructions) {
      lines.push(`From ${sourceId}:`);
      lines.push(`> ${text.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }
  }

  for (const sourceId of typeData.sources) {
    try {
      const [pluginName, sourceName] = sourceId.split('/');
      const pluginPath = path.join(projectRoot, 'plugins', pluginName);
      const readScript = path.join(pluginPath, 'read.js');

      if (!fs.existsSync(readScript)) continue;

      const sources = getPluginSources(pluginName);
      const sourceConfig = sources.find(s => s.sourceName === sourceName)?.config || {};

      if (process.env.TODAY_QUIET !== '1') console.log(`  ⏳ ${pluginName}...`);

      const output = execSync(`node "${readScript}"`, {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          PROJECT_ROOT: projectRoot,
          CONFIG_PATH: getConfigPath(),
          PLUGIN_CONFIG: JSON.stringify(sourceConfig),
          SOURCE_ID: sourceId,
          CONTEXT_ONLY: 'true' // Skip expensive operations during context gathering
        }
      });

      const data = JSON.parse(output);

      if (data.context) {
        lines.push(data.context);
        lines.push('');
      }
    } catch {
      // Silently continue if plugin fails
    }
  }

  return lines.length > 2 ? lines.join('\n') : null;
}

/**
 * Gather the current data context by running each enabled plugin's command in
 * CONTEXT_ONLY mode. This is the expensive step the cache avoids repeating.
 * Moved verbatim from bin/today's getDataContext().
 */
async function gatherCurrentDataContext(projectRoot) {
  if (process.env.SKIP_CONTEXT === 'true') {
    return `# Data Sources
(Context gathering skipped for testing)`;
  }

  try {
    const pluginTypes = getPluginTypes();
    const instructionsByType = await getAIInstructionsByType();
    const sections = [];

    for (const pluginType of pluginTypes) {
      const ai = getAIMetadata(pluginType);
      if (!ai) continue;

      if (pluginType === 'context') {
        const contextData = await getContextPluginsData(instructionsByType.get('context'), projectRoot);
        if (contextData) {
          sections.push(contextData);
        }
        continue;
      }

      const typeData = instructionsByType.get(pluginType);
      if (!typeData || typeData.sources.length === 0) continue;

      let currentData = '';
      try {
        if (process.env.TODAY_QUIET !== '1') console.log(`  ⏳ ${ai.name || pluginType}...`);
        currentData = execSync(ai.defaultCommand + ' 2>/dev/null', {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, CONTEXT_ONLY: 'true' }
        });
        currentData = currentData.split('\n')
          .filter(line => !line.includes('[dotenvx'))
          .join('\n');
      } catch {
        currentData = '(No data available)';
      }

      const block = generateAIContextBlock(pluginType, {
        userInstructions: typeData.instructions,
        currentData
      });

      if (block) {
        sections.push(block);
      }
    }

    if (sections.length === 0) {
      return `# Data Sources

**No plugins are currently enabled.**

Today works best when connected to your data sources (calendars, tasks, notes, etc.).
Run \`bin/today configure\` and select "Plugins" to enable data sources.

Available plugin types include:
- Calendars (Google Calendar, public calendars)
- Tasks and projects (GitHub, markdown files)
- Notes and diary (Day One, markdown files)
- Time tracking, habits, health metrics
- Weather and other context

The more data sources you enable, the more helpful Today can be.
`;
    }

    const intro = `# Data Sources

The following data is synced from external sources via the plugin system.
Each section shows current data and instructions for querying more.

- Run \`bin/plugins list\` to see available plugins
- Run \`bin/plugins sync\` to refresh data from all sources
- Run \`bin/plugins sync <plugin-name>\` to sync a specific plugin

`;

    return intro + sections.join('\n\n---\n\n');
  } catch (error) {
    return '';
  }
}

/**
 * Gather data context for a specific historical date.
 * Moved verbatim from bin/today's getDataContextForDate().
 */
async function gatherDataContextForDate(targetDate, projectRoot) {
  const sections = [];
  const pluginTypes = getPluginTypes();
  const historicalTypes = ['time-logs', 'diary', 'events', 'tasks', 'habits'];

  for (const pluginType of pluginTypes) {
    if (!historicalTypes.includes(pluginType)) continue;

    const schema = schemas[pluginType];
    if (!schema || !schema.ai?.dateCommand) continue;

    const command = schema.ai.dateCommand.replace('$DATE', targetDate);

    try {
      const output = execSync(command, {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const cleanOutput = output.split('\n')
        .filter(line => !line.includes('[dotenvx'))
        .join('\n')
        .trim();

      if (!cleanOutput || cleanOutput.includes('No ')) continue;

      const block = generateAIContextBlock(pluginType, {
        userInstructions: [],
        currentData: cleanOutput,
        commandUsed: command
      });

      if (block) {
        sections.push(block);
      }
    } catch {
      // Command failed - skip this type
    }
  }

  if (sections.length === 0) {
    return `# Data Sources\n(No data found for ${targetDate})`;
  }

  const intro = `# Data Sources for ${targetDate}

The following data was retrieved for the specified date.

`;

  return intro + sections.join('\n\n---\n\n');
}

/**
 * Gather data context (live or for a historical date) without consulting the
 * cache. This is the expensive path.
 * @param {object} params
 * @param {string} params.projectRoot
 * @param {string|null} [params.targetDate]
 * @returns {Promise<string>}
 */
export async function gatherDataContext({ projectRoot, targetDate = null }) {
  return targetDate
    ? gatherDataContextForDate(targetDate, projectRoot)
    : gatherCurrentDataContext(projectRoot);
}

/**
 * Get data context, served from the context_cache when nothing relevant has
 * changed. On a miss (or when bypassed) it gathers fresh, stores, and returns.
 *
 * @param {object} params
 * @param {object} params.db - Database instance
 * @param {string} params.projectRoot
 * @param {string|null} [params.targetDate] - Historical date, if any
 * @param {boolean} [params.bypass] - Force a fresh gather (still updates cache)
 * @returns {Promise<{content: string, cached: boolean}>}
 */
export async function getDataContextCached({ db, projectRoot, targetDate = null, bypass = false }) {
  // Preserve the SKIP_CONTEXT test short-circuit without touching the cache.
  if (process.env.SKIP_CONTEXT === 'true' && !targetDate) {
    return { content: await gatherDataContext({ projectRoot, targetDate }), cached: false };
  }

  let key = null;
  try {
    const dayKey = getTodayDate(getTimezone());
    const instructionsByType = await getAIInstructionsByType();
    key = computeContextCacheKey({ db, instructionsByType, dayKey, targetDate });
  } catch {
    // If we can't compute a key, fall back to always gathering fresh.
    key = null;
  }

  if (key && !bypass) {
    const hit = getCachedContext(db, key);
    if (hit !== null) {
      return { content: hit, cached: true };
    }
  }

  const content = await gatherDataContext({ projectRoot, targetDate });
  if (key) setCachedContext(db, key, content);
  return { content, cached: false };
}
