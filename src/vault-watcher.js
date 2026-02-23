#!/usr/bin/env node

import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  getTimezone, getAbsoluteVaultPath, getConfig, getVaultPath,
  getConfigPath, clearConfigCache
} from './config.js';
import { getDatabase } from './database-service.js';
import { ensureHealthyDatabase } from './db-health.js';
import { discoverPlugins, getPluginSources, syncPluginSource } from './plugin-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.dirname(__dirname);

// Load configuration
const configuredTimezone = getTimezone();
process.env.TZ = configuredTimezone;

const VAULT_DIR = getAbsoluteVaultPath();
const DEFAULT_DEBOUNCE = 3000;
const DEFAULT_IGNORE = ['.stfolder', '.stversions', '.backups', '.DS_Store'];

// Plugins that scan the entire vault and are too expensive for real-time watching.
// These run on the scheduler's 10-minute cron instead.
const DEFAULT_EXCLUDE_PLUGINS = [
  'markdownlint-cleanup',
  'icloud-conflict-cleanup',
  'resilio-conflict-cleanup',
  'vault-changes'
];

function loadWatcherConfig() {
  const cfg = getConfig('watcher') || {};
  return {
    debounce: cfg.debounce || DEFAULT_DEBOUNCE,
    ignore: cfg.ignore || DEFAULT_IGNORE,
    exclude_plugins: cfg.exclude_plugins || DEFAULT_EXCLUDE_PLUGINS
  };
}

let watcherConfig = loadWatcherConfig();

/**
 * Extract vault directories that a plugin source monitors.
 * Reads directory/path settings from plugin.toml defaults and user config overrides.
 */
function getWatchedVaultPaths(plugin, sourceConfig) {
  const settings = plugin.settings || {};
  const paths = [];

  for (const [key, schema] of Object.entries(settings)) {
    if (key !== 'directory' && key !== 'file_path' &&
        !key.endsWith('_directory') && !key.endsWith('_path')) {
      continue;
    }

    // User config overrides plugin default
    const value = sourceConfig[key] ?? schema.default;
    if (!value || typeof value !== 'string') continue;

    // Strip glob patterns to get base directory
    let dirPath = value.replace(/\*\*.*$/, '').replace(/\*[^/]*$/, '').replace(/\/+$/, '');
    if (!dirPath) continue;

    const absolute = path.resolve(PROJECT_ROOT, dirPath);

    // Only include paths within the vault
    if (absolute === VAULT_DIR || absolute.startsWith(VAULT_DIR + path.sep)) {
      paths.push(absolute);
    }
  }

  return paths;
}

/**
 * Build a mapping of vault paths to plugin sources.
 * Returns entries sorted so specific paths match before broad ones.
 */
async function buildWatchMap() {
  const plugins = await discoverPlugins();
  const excluded = new Set(watcherConfig.exclude_plugins);
  const watchMap = [];

  for (const [name, plugin] of plugins) {
    if (!plugin.commands?.read) continue;
    if (excluded.has(name)) continue;

    const sources = getPluginSources(name);
    for (const { sourceName, config: sourceConfig } of sources) {
      const vaultPaths = getWatchedVaultPaths(plugin, sourceConfig);
      if (vaultPaths.length > 0) {
        watchMap.push({
          plugin,
          sourceName,
          sourceConfig,
          paths: vaultPaths,
          sourceId: `${name}/${sourceName}`
        });
      }
    }
  }

  // Sort: more specific (longer) paths first so they match before catch-all "vault/"
  watchMap.sort((a, b) => {
    const aMax = Math.max(...a.paths.map(p => p.length));
    const bMax = Math.max(...b.paths.map(p => p.length));
    return bMax - aMax;
  });

  return watchMap;
}

function logWatchMap(map) {
  console.log(`Plugin watch map (${map.length} source(s)):`);
  for (const entry of map) {
    const dirs = entry.paths.map(p => path.relative(PROJECT_ROOT, p) || '(root)').join(', ');
    console.log(`  ${entry.sourceId} → ${dirs}`);
  }
}

/**
 * Find which plugin sources are affected by a changed file.
 * Returns deduplicated list of sources whose watched paths contain the file.
 */
function getAffectedSources(watchMap, changedFiles) {
  const seen = new Set();
  const affected = [];

  for (const entry of watchMap) {
    if (seen.has(entry.sourceId)) continue;

    for (const filePath of changedFiles) {
      let matches = false;
      for (const watchPath of entry.paths) {
        if (filePath === watchPath || filePath.startsWith(watchPath + path.sep)) {
          matches = true;
          break;
        }
      }
      if (matches) {
        seen.add(entry.sourceId);
        affected.push(entry);
        break;
      }
    }
  }

  return affected;
}

function timestamp() {
  return new Date().toLocaleString('en-US', { timeZone: configuredTimezone, hour12: false });
}

// --- Main ---

console.log('Vault watcher starting...');
console.log(`Watching: ${VAULT_DIR}`);
console.log(`Timezone: ${configuredTimezone}`);
console.log(`Debounce: ${watcherConfig.debounce}ms`);
console.log(`Ignored: ${watcherConfig.ignore.join(', ')}`);
console.log(`Excluded plugins: ${watcherConfig.exclude_plugins.join(', ')}`);

// Ensure database is healthy before starting
const healthResult = await ensureHealthyDatabase({ verbose: false });
if (!healthResult.success) {
  console.error('Database health check failed, exiting');
  process.exit(1);
}

// Build the watch map from enabled plugins
let watchMap = await buildWatchMap();

if (watchMap.length === 0) {
  console.log('No vault-watching plugins are enabled. Nothing to do.');
  process.exit(0);
}

console.log('');
logWatchMap(watchMap);

// State
let isSyncing = false;
let pendingChanges = new Set();
let debounceTimer = null;

const vaultPath = path.join(PROJECT_ROOT, getVaultPath());

async function runSync() {
  if (fs.existsSync(path.join(PROJECT_ROOT, 'SYNC_DISABLED'))) {
    console.log(`[${timestamp()}] Sync disabled, skipping`);
    return;
  }

  if (isSyncing) {
    return; // Changes accumulate in pendingChanges via scheduleSync
  }

  // Grab current batch and clear
  const changedFiles = Array.from(pendingChanges);
  pendingChanges.clear();

  if (changedFiles.length === 0) return;

  const affected = getAffectedSources(watchMap, changedFiles);
  if (affected.length === 0) {
    console.log(`[${timestamp()}] No plugins affected by ${changedFiles.length} change(s)`);
    return;
  }

  isSyncing = true;
  console.log(`\n[${timestamp()}] Syncing ${affected.length} source(s) for ${changedFiles.length} file(s)...`);

  // Build relative file filter for targeted sync (e.g. "vault/plans/foo.md,vault/plans/bar.md")
  const relativeFiles = changedFiles.map(f => path.relative(PROJECT_ROOT, f));
  const fileFilter = relativeFiles.join(',');

  const db = getDatabase();
  const context = { db, vaultPath };

  for (const entry of affected) {
    try {
      console.log(`  ${entry.sourceId}...`);
      const result = await syncPluginSource(
        entry.plugin, entry.sourceName, entry.sourceConfig, context,
        { fileFilter, _caller: 'vault-watcher' }
      );
      if (result.success) {
        console.log(`    ${result.message}`);
      } else {
        console.error(`    Failed: ${result.message}`);
      }
    } catch (error) {
      console.error(`    Error: ${error.message}`);
    }
  }

  isSyncing = false;

  // If more changes arrived during sync, schedule another run
  if (pendingChanges.size > 0) {
    console.log(`[${timestamp()}] Changes queued during sync, re-running...`);
    debounceTimer = setTimeout(runSync, watcherConfig.debounce);
  }
}

function scheduleSync(filePath) {
  pendingChanges.add(filePath);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSync, watcherConfig.debounce);
}

// Build chokidar ignored patterns from config
const ignoredPatterns = [
  /(^|[/\\])\./,    // dotfiles
  ...watcherConfig.ignore.map(dir => `**/${dir}/**`),
  '**/*.sync-conflict-*'
];

const watcher = chokidar.watch(VAULT_DIR, {
  ignored: ignoredPatterns,
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 500,
    pollInterval: 100
  }
});

function onFileEvent(event, filePath) {
  if (!filePath.endsWith('.md')) return;
  const rel = path.relative(VAULT_DIR, filePath);
  console.log(`[${timestamp()}] ${event}: ${rel}`);
  scheduleSync(filePath);
}

watcher
  .on('change', (fp) => onFileEvent('Changed', fp))
  .on('add', (fp) => onFileEvent('Added', fp))
  .on('unlink', (fp) => onFileEvent('Removed', fp))
  .on('ready', () => {
    console.log(`\nWatcher ready. Waiting for changes...\n`);
  })
  .on('error', (error) => {
    console.error(`Watcher error: ${error.message}`);
  });

// --- Config file hot-reload ---

const configPath = getConfigPath();
let configReloadTimer = null;

async function reloadConfig() {
  console.log(`\n[${timestamp()}] Config changed, reloading...`);
  clearConfigCache();

  // Reload watcher settings
  const newConfig = loadWatcherConfig();
  if (newConfig.debounce !== watcherConfig.debounce) {
    console.log(`  Debounce: ${watcherConfig.debounce}ms → ${newConfig.debounce}ms`);
  }
  if (JSON.stringify(newConfig.ignore) !== JSON.stringify(watcherConfig.ignore)) {
    console.log(`  Ignored dirs updated (restart watcher to apply new ignore patterns)`);
  }
  watcherConfig = newConfig;

  // Rebuild watch map
  const oldIds = new Set(watchMap.map(e => e.sourceId));
  watchMap = await buildWatchMap();
  const newIds = new Set(watchMap.map(e => e.sourceId));

  const added = watchMap.filter(e => !oldIds.has(e.sourceId));
  const removed = [...oldIds].filter(id => !newIds.has(id));

  if (added.length > 0 || removed.length > 0) {
    if (added.length > 0) {
      for (const entry of added) {
        const dirs = entry.paths.map(p => path.relative(PROJECT_ROOT, p)).join(', ');
        console.log(`  + ${entry.sourceId} → ${dirs}`);
      }
    }
    if (removed.length > 0) {
      for (const id of removed) {
        console.log(`  - ${id}`);
      }
    }
  } else {
    console.log('  Watch map unchanged');
  }

  console.log('');
}

try {
  fs.watch(configPath, { persistent: false }, () => {
    clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(reloadConfig, 1000);
  });
  console.log(`Config: ${path.relative(PROJECT_ROOT, configPath)} (watching for changes)`);
} catch (error) {
  console.log(`Config: ${path.relative(PROJECT_ROOT, configPath)} (not watching: ${error.message})`);
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  clearTimeout(debounceTimer);
  clearTimeout(configReloadTimer);
  watcher.close().then(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
