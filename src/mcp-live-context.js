/**
 * Live context-plugin output for the MCP get_context tool.
 *
 * Runs each enabled context plugin's read.js directly, the way bin/context
 * does, with three differences for a remote caller:
 *   - each plugin runs in its own process group, so a timeout tears down
 *     anything it spawned (see src/process-group.js);
 *   - plugins run with TZ set to the user's configured zone, so "today" in
 *     their output matches the time zone the reply names;
 *   - plugins whose output names the user's location (weather) are skipped
 *     unless `[mcp] profile_fields` shares `location`.
 *
 * On a read-only connection nothing runs: markdown-plans creates and updates
 * plan files even in context-only mode, so running it would write to the
 * vault.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSourcesForType } from './plugin-loader.js';
import { getConfigPath } from './config.js';
import { getConfiguredTimezone } from './date-utils.js';
import { execGroup } from './process-group.js';
import { getProfileFields } from './mcp-guidance.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LIVE_CONTEXT_TIMEOUT_MS = 30 * 1000;
const LIVE_CONTEXT_MAX_BUFFER = 8 * 1024 * 1024;

// Context plugins whose output states where the user is.
export const LOCATION_PLUGINS = new Set(['weather-context']);

export const READ_ONLY_NOTE = 'Live context is not run on a read-only connection, because a context plugin writes plan files in the vault.';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Which context sources may run for an MCP caller, and why the rest don't.
 * @returns {{run: object[], skipped: Array<{sourceId: string, reason: string}>}}
 */
export function selectContextSources(sources, config) {
  const fields = new Set(getProfileFields(config));
  const run = [];
  const skipped = [];
  for (const source of sources) {
    const pluginName = source.plugin?.name || source.pluginName;
    if (LOCATION_PLUGINS.has(pluginName) && !fields.has('location')) {
      skipped.push({ sourceId: source.sourceId, reason: "it names the user's location, which [mcp] profile_fields doesn't share" });
      continue;
    }
    run.push(source);
  }
  return { run, skipped };
}

/** Run one context plugin in its own process group; returns {data} or {error}. */
export async function runContextSource({ sourceId, pluginName, config }, { timezone, projectRoot = PROJECT_ROOT } = {}) {
  const readScript = path.join(projectRoot, 'plugins', pluginName, 'read.js');
  if (!fs.existsSync(readScript)) return { error: 'no read.js' };
  try {
    const { stdout } = await execGroup(`node ${shellQuote(readScript)}`, {
      cwd: projectRoot,
      timeoutMs: LIVE_CONTEXT_TIMEOUT_MS,
      killGraceMs: 2000,
      maxBuffer: LIVE_CONTEXT_MAX_BUFFER,
      env: {
        ...process.env,
        TZ: timezone,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        PROJECT_ROOT: projectRoot,
        CONFIG_PATH: getConfigPath(),
        PLUGIN_CONFIG: JSON.stringify(config || {}),
        SOURCE_ID: sourceId,
        CONTEXT_ONLY: 'true',
      },
    });
    const json = stdout.split('\n').filter(l => !l.includes('[dotenvx')).join('\n').trim();
    return { data: JSON.parse(json) };
  } catch (error) {
    return { error: error.message };
  }
}

function formatResult(pluginName, data) {
  const body = data && typeof data.context === 'string'
    ? data.context
    : JSON.stringify(data, null, 2);
  return `### ${pluginName}\n\n${body.replace(/\x1b\[[0-9;]*m/g, '').trim()}`;
}

/**
 * The live-context section of get_context, or null when there is nothing.
 *
 * @param {{readOnly?: boolean, config?: object, timezone?: string,
 *   getSources?: Function, run?: Function}} options
 * @returns {Promise<string|null>}
 */
export async function readLiveContext({
  readOnly = false,
  config,
  timezone = getConfiguredTimezone(),
  getSources = getSourcesForType,
  run = runContextSource,
} = {}) {
  if (readOnly) return READ_ONLY_NOTE;

  let sources;
  try {
    ({ sources } = await getSources('context'));
  } catch {
    return null;
  }
  const { run: toRun, skipped } = selectContextSources(sources || [], config);

  const entries = toRun.map(({ sourceId, plugin, pluginName, config: sourceConfig }) => ({
    sourceId,
    pluginName: plugin?.name || pluginName,
    config: sourceConfig,
  }));
  const results = await Promise.all(entries.map(entry => run(entry, { timezone })));

  const parts = [];
  results.forEach((result, i) => {
    if (result?.data) parts.push(formatResult(entries[i].pluginName, result.data));
  });
  const notes = [
    ...skipped.map(s => `${s.sourceId} was left out because ${s.reason}.`),
    ...results.map((r, i) => (r?.error ? `${entries[i].sourceId} failed or ran too long.` : null)).filter(Boolean),
  ];
  if (notes.length > 0) parts.push(notes.map(n => `- ${n}`).join('\n'));
  return parts.length > 0 ? parts.join('\n\n') : null;
}
