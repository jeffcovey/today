#!/usr/bin/env node

/**
 * Markdownlint Cleanup Plugin - Sync Command
 *
 * Runs markdownlint-cli2 with --fix to auto-correct markdown formatting issues.
 *
 * Uses src/vault-changes.js to only process files that have actually changed
 * today (added or modified), making it much faster than scanning everything.
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getChangedFilePaths, updateBaseline, getBaselineStatus } from '../../src/vault-changes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Read settings from environment (set by plugin loader)
const directory = process.env.PLUGIN_SETTING_DIRECTORY || `${process.env.VAULT_PATH}/**/*.md`;
const vaultDir = directory.replace('/**/*.md', '').replace('/*.md', '');

/**
 * Run markdownlint on specific files
 */
function lintFiles(files) {
  if (files.length === 0) {
    return { cleaned: 0, message: 'No changed markdown files to process' };
  }

  // markdownlint-cli2 can take multiple file arguments
  const fileArgs = files.map(f => `"${f}"`).join(' ');

  try {
    execSync(`npx markdownlint-cli2 --fix ${fileArgs}`, {
      stdio: 'pipe',
      cwd: PROJECT_ROOT
    });
    return { cleaned: 0, message: `Checked ${files.length} file(s) - all clean` };
  } catch (error) {
    return { cleaned: files.length, message: `Fixed formatting in ${files.length} file(s)` };
  }
}

/**
 * Run markdownlint on all files matching glob pattern
 */
function lintAllFiles() {
  try {
    execSync(`npx markdownlint-cli2 --fix "${directory}"`, {
      stdio: 'pipe',
      cwd: PROJECT_ROOT
    });
    return { cleaned: 0, message: 'All markdown files are clean' };
  } catch (error) {
    return { cleaned: 1, message: 'Fixed formatting in markdown files' };
  }
}

function sync() {
  // Check if baseline exists
  const status = getBaselineStatus({ sourceId: 'vault-changes/default' });

  if (!status.exists) {
    // Initialize baseline - first run establishes tracking
    console.error('No vault-changes baseline found, initializing...');
    updateBaseline({ directory: vaultDir });
    console.error('Baseline initialized - subsequent runs will be incremental');

    // Do a full lint on first run
    const result = lintAllFiles();
    console.log(JSON.stringify({
      ...result,
      mode: 'initial'
    }));
    return;
  }

  // Get changed files using the vault-changes module
  const changedFiles = getChangedFilePaths({
    directory: vaultDir,
    todayOnly: true,
    includeGit: false
  });

  const result = lintFiles(changedFiles);
  result.filesChecked = changedFiles.length;

  console.log(JSON.stringify({
    ...result,
    mode: 'incremental'
  }));
}

sync();
