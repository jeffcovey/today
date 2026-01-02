#!/usr/bin/env node

/**
 * Vault Changes Plugin - Write Command
 *
 * Handles write operations for manual baseline management.
 * Primary action: update-baseline - saves current file checksums to database
 */

import { updateBaseline, getBaselineStatus } from '../../src/vault-changes.js';

// Read settings from environment (set by plugin loader)
const directory = process.env.PLUGIN_SETTING_DIRECTORY || process.env.VAULT_PATH;
const excludeDirsStr = process.env.PLUGIN_SETTING_EXCLUDEDIRS || '.sync,templates,.git,.git.nosync,.obsidian,.trash';
const excludeDirs = new Set(excludeDirsStr.split(',').map(d => d.trim()));

// Parse entry
const entryJson = process.env.ENTRY_JSON || '{}';
let entry;
try {
  entry = JSON.parse(entryJson);
} catch (error) {
  console.log(JSON.stringify({ success: false, error: `Invalid ENTRY_JSON: ${error.message}` }));
  process.exit(1);
}

const action = entry.action || 'update-baseline';

let result;
switch (action) {
  case 'update-baseline':
    result = updateBaseline({ directory, excludeDirs });
    result.message = `Baseline updated: ${result.fileCount} files tracked`;
    break;
  case 'status':
    result = getBaselineStatus();
    result.success = true;
    break;
  default:
    result = { success: false, error: `Unknown action: ${action}` };
}

console.log(JSON.stringify(result));
