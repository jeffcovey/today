#!/usr/bin/env node

/**
 * Markdownlint Cleanup Plugin - Sync Command
 *
 * Uses the markdownlint Node API directly (no child process) to auto-fix
 * markdown formatting issues.
 *
 * Uses src/vault-changes.js to only process files that have actually changed
 * today (added or modified), making it much faster than scanning everything.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { lint, readConfig } from 'markdownlint/sync';
import { applyFixes } from 'markdownlint';
import { getChangedFilePaths, updateBaseline, getBaselineStatus } from '../../src/vault-changes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const pluginConfig = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const directory = pluginConfig.directory || `${process.env.VAULT_PATH}/**/*.md`;
const vaultDir = directory.replace('/**/*.md', '').replace('/*.md', '');

// Load config once
const markdownlintConfig = readConfig(path.join(PROJECT_ROOT, '.markdownlint.json'));

/**
 * Lint and fix specific files using the markdownlint Node API
 */
function lintAndFix(files) {
  if (files.length === 0) {
    return { cleaned: 0, message: 'No changed markdown files to process' };
  }

  const result = lint({ files, config: markdownlintConfig });

  let fixedCount = 0;
  for (const file of files) {
    const issues = result[file];
    if (!issues || issues.length === 0) continue;

    const fixableIssues = issues.filter(i => i.fixInfo);
    if (fixableIssues.length === 0) continue;

    const content = fs.readFileSync(file, 'utf8');
    const fixed = applyFixes(content, issues);
    if (fixed !== content) {
      fs.writeFileSync(file, fixed, 'utf8');
      fixedCount++;
    }
  }

  if (fixedCount === 0) {
    return { cleaned: 0, message: `Checked ${files.length} file(s) - all clean` };
  }
  return { cleaned: fixedCount, message: `Fixed formatting in ${fixedCount} file(s)` };
}

function sync() {
  // If FILE_FILTER is set (e.g. from vault watcher), only lint those specific files
  const fileFilter = process.env.FILE_FILTER;
  if (fileFilter) {
    const files = fileFilter.split(',').filter(f => f.endsWith('.md'));
    const result = lintAndFix(files);
    result.filesChecked = files.length;
    console.log(JSON.stringify({ ...result, mode: 'targeted' }));
    return;
  }

  // Check if baseline exists
  const status = getBaselineStatus({ sourceId: 'vault-changes/default' });

  if (!status.exists) {
    // Initialize baseline - first run establishes tracking
    console.error('No vault-changes baseline found, initializing...');
    updateBaseline({ directory: vaultDir });
    console.error('Baseline initialized - subsequent runs will be incremental');

    // Do a full lint on first run
    const allFiles = glob.sync(directory, { cwd: PROJECT_ROOT });
    const result = lintAndFix(allFiles);
    console.log(JSON.stringify({ ...result, mode: 'initial' }));
    return;
  }

  // Get changed files using the vault-changes module
  const changedFiles = getChangedFilePaths({
    directory: vaultDir,
    todayOnly: true,
    includeGit: false
  });

  const result = lintAndFix(changedFiles);
  result.filesChecked = changedFiles.length;

  console.log(JSON.stringify({
    ...result,
    mode: 'incremental'
  }));
}

sync();
