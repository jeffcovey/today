#!/usr/bin/env node

/**
 * Vault Changes Plugin - Context Display
 *
 * Thin wrapper around src/vault-changes.js that formats change information
 * for display in bin/context and daily reviews.
 *
 * Disabling this plugin only hides the display - the core change tracking
 * remains available to other plugins.
 */

import { getChangedFiles, formatChangesAsContext } from '../../src/vault-changes.js';

// Read settings from environment (set by plugin loader)
const directory = process.env.PLUGIN_SETTING_DIRECTORY || 'vault';
const excludeDirsStr = process.env.PLUGIN_SETTING_EXCLUDEDIRS || '.sync,templates,.git,.git.nosync,.obsidian,.trash';
const excludeDirs = new Set(excludeDirsStr.split(',').map(d => d.trim()));

// Get changes with git info
const changes = getChangedFiles({
  directory,
  excludeDirs,
  todayOnly: true,
  includeGit: true,
  autoInitBaseline: true
});

// Format as context string
const context = formatChangesAsContext(changes);

// Output for plugin system
console.log(JSON.stringify({
  context,
  mode: changes.initialized ? 'initialized' : 'content-aware',
  count: changes.count,
  added: changes.added,
  modified: changes.modified,
  deleted: changes.deleted,
  touched: changes.touched,
  git: changes.git,
  trackedFiles: changes.trackedFiles,
  message: changes.initialized
    ? `Baseline initialized with ${changes.trackedFiles} files`
    : `${changes.count} change(s) detected`
}));
