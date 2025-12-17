#!/usr/bin/env node

/**
 * Markdownlint Cleanup Plugin - Sync Command
 *
 * Runs markdownlint-cli2 with --fix to auto-correct markdown formatting issues.
 *
 * When vault-changes plugin is enabled, only processes files that have
 * actually changed today (added or modified), making it much faster.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.join(PROJECT_ROOT, '.data/today.db');

// Read settings from environment (set by plugin loader)
const directory = process.env.PLUGIN_SETTING_DIRECTORY || 'vault/**/*.md';

/**
 * Get changed markdown files from vault-changes plugin data
 * Returns null if vault-changes isn't available/enabled
 */
async function getChangedFilesFromVaultChanges() {
  if (!fs.existsSync(DB_PATH)) {
    return null;
  }

  try {
    // Dynamic import to avoid issues if better-sqlite3 isn't available
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(DB_PATH, { readonly: true });

    // Check if vault_files table exists and has data
    const tableCheck = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='vault_files'
    `).get();

    if (!tableCheck) {
      db.close();
      return null;
    }

    // Check if there's any baseline data - if not, run vault-changes to initialize
    const countResult = db.prepare('SELECT COUNT(*) as count FROM vault_files').get();
    if (!countResult || countResult.count === 0) {
      db.close();
      // Run vault-changes plugin to initialize baseline
      try {
        console.error('No vault-changes baseline found, initializing...');
        execSync('node plugins/vault-changes/read.js', {
          cwd: PROJECT_ROOT,
          stdio: ['pipe', 'pipe', 'inherit']
        });
        console.error('Baseline initialized - subsequent runs will be incremental');
        // Return empty array - first run just established baseline
        return [];
      } catch {
        return null; // Fall back to full scan
      }
    }

    // Get start of today
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayMidnightMs = todayMidnight.getTime();

    // Get all tracked files and their stored mtimes
    const storedFiles = db.prepare(`
      SELECT path, mtime_ms FROM vault_files
      WHERE path LIKE '%.md'
    `).all();

    db.close();

    // Find files that have been modified since their stored mtime
    // or are new (not in database)
    const changedFiles = [];
    const storedByPath = new Map(storedFiles.map(f => [f.path, f.mtime_ms]));

    // Check each stored file for changes
    for (const [filepath, storedMtime] of storedByPath) {
      try {
        if (!fs.existsSync(filepath)) continue;
        const stat = fs.statSync(filepath);

        // Only include if modified today and mtime differs from stored
        if (stat.mtimeMs >= todayMidnightMs && stat.mtimeMs !== storedMtime) {
          changedFiles.push(filepath);
        }
      } catch {
        // Skip files we can't access
      }
    }

    // Also find new .md files in vault that aren't tracked yet
    // (Simple check - just look for files modified today not in database)
    const vaultDir = directory.replace('/**/*.md', '').replace('/*.md', '');
    if (fs.existsSync(vaultDir)) {
      findNewMarkdownFiles(vaultDir, storedByPath, todayMidnightMs, changedFiles);
    }

    return changedFiles;
  } catch (error) {
    // If anything fails, return null to fall back to full scan
    return null;
  }
}

/**
 * Recursively find new markdown files not in the database
 */
function findNewMarkdownFiles(dir, storedByPath, todayMidnightMs, results, excludeDirs = new Set(['.sync', 'templates', '.git', '.git.nosync', '.obsidian', '.trash'])) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (excludeDirs.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        findNewMarkdownFiles(fullPath, storedByPath, todayMidnightMs, results, excludeDirs);
      } else if (entry.name.endsWith('.md') && !storedByPath.has(fullPath)) {
        // New file not in database - check if modified today
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs >= todayMidnightMs) {
            results.push(fullPath);
          }
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // Skip directories we can't read
  }
}

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

async function sync() {
  // Try to use vault-changes data for efficiency
  const changedFiles = await getChangedFilesFromVaultChanges();

  let result;
  let mode;

  if (changedFiles !== null) {
    // vault-changes is available - only lint changed files
    mode = 'incremental';
    result = lintFiles(changedFiles);
    result.filesChecked = changedFiles.length;
  } else {
    // Fall back to full scan
    mode = 'full';
    result = lintAllFiles();
  }

  console.log(JSON.stringify({
    ...result,
    mode
  }));
}

sync();
