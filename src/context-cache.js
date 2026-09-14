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
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

import { getPluginTypes, getAIMetadata, generateAIContextBlock, schemas } from './plugin-schemas.js';
import { getAIInstructionsByType, getPluginSources, runContextPlugins } from './plugin-loader.js';
import { getConfigPath, getTimezone } from './config.js';
import { getTodayDate } from './date-utils.js';

// Bump when the gather logic below changes in a way that should invalidate
// every existing cache entry across an upgrade.
export const CONTEXT_CACHE_VERSION = 2;

// How many cache rows to retain (one per distinct fingerprint: live + a few
// historical-date lookups). Older rows are pruned on each write.
const MAX_CACHE_ROWS = 5;

// How many plugin-type commands to run at once. These are separate node
// processes, so the ceiling is cores rather than I/O; measured on a 4-core box,
// a limit of 4 matched unbounded (5088ms vs 4897ms) while spawning far fewer
// processes.
const GATHER_CONCURRENCY = Math.max(2, os.cpus()?.length || 4);

/**
 * Map over items with a bounded number in flight, returning results in input
 * order rather than completion order.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );

  return results;
}

/**
 * Snapshot the per-source sync state for cache keying.
 * Uses entries_count (changes only when row counts change) rather than
 * last_synced_at (changes on every background sync even when data is identical),
 * so the cache stays valid across syncs that bring in no new data.
 * @param {object} db
 * @returns {Array<object>}
 */
function getSyncSnapshot(db) {
  try {
    return db.prepare(
      'SELECT source, entries_count FROM sync_metadata ORDER BY source'
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

  const entries = typeData.sources.map(sourceId => {
    const [pluginName, sourceName] = sourceId.split('/');
    let config = {};
    try {
      config = getPluginSources(pluginName).find(s => s.sourceName === sourceName)?.config || {};
    } catch {
      config = {};
    }
    return { sourceId, pluginName, config };
  });

  const quiet = process.env.TODAY_QUIET === '1';
  const results = await runContextPlugins(
    entries,
    projectRoot,
    quiet ? null : pluginName => console.log(`  ⏳ ${pluginName}...`)
  );

  // Results arrive in source order, so the gathered context — and therefore
  // what gets cached — is identical run to run.
  for (const { data } of results) {
    if (data?.context) {
      lines.push(data.context);
      lines.push('');
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

    // Collect the work first, in plugin-type order, then run it concurrently.
    // Every command is read-only here — ensureSyncForType returns early when
    // CONTEXT_ONLY is set — so there is no write contention between them.
    const tasks = [];
    for (const pluginType of pluginTypes) {
      const ai = getAIMetadata(pluginType);
      if (!ai) continue;

      if (pluginType === 'context') {
        tasks.push({ pluginType, ai, isContext: true });
        continue;
      }

      const typeData = instructionsByType.get(pluginType);
      if (!typeData || typeData.sources.length === 0) continue;

      tasks.push({ pluginType, ai, typeData, isContext: false });
    }

    const quiet = process.env.TODAY_QUIET === '1';

    const results = await mapWithConcurrency(tasks, GATHER_CONCURRENCY, async task => {
      if (task.isContext) {
        return getContextPluginsData(instructionsByType.get('context'), projectRoot);
      }

      if (!quiet) console.log(`  ⏳ ${task.ai.name || task.pluginType}...`);

      let currentData = '';
      try {
        const { stdout } = await execAsync(task.ai.defaultCommand + ' 2>/dev/null', {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, CONTEXT_ONLY: 'true' }
        });
        currentData = stdout.split('\n')
          .filter(line => !line.includes('[dotenvx'))
          .join('\n');
      } catch {
        currentData = '(No data available)';
      }

      return generateAIContextBlock(task.pluginType, {
        userInstructions: task.typeData.instructions,
        currentData
      });
    });

    // Results stay in plugin-type order regardless of completion order, so the
    // gathered text — and therefore the cache entry — is identical run to run.
    const sections = results.filter(Boolean);

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
