#!/usr/bin/env node

/**
 * Obsidian Sync Conflict Cleanup Plugin - Sync Command
 *
 * Cleans up conflict files created by Obsidian Sync.
 * Conflict files have the `.!sync` extension, e.g. `filename.!sync` alongside `filename.md`.
 */

import fs from 'fs';
import path from 'path';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

const directory = path.join(projectRoot, config.directory || process.env.VAULT_PATH || 'vault');

const CONFLICT_EXT = '.!sync';

const skipDirsDefault = 'node_modules,.git,.git.nosync,.sync,.obsidian,.stfolder,.stversions,.backups,_tmp';
const SKIP_DIRS = new Set(
  (config.skip_directories || skipDirsDefault).split(',').map(s => s.trim())
);

/**
 * Find all .!sync conflict files in the directory
 */
function findConflictFiles(dir) {
  const results = [];
  const resolvedDir = fs.realpathSync(dir);

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith(CONFLICT_EXT)) {
        results.push(path.join(currentDir, entry.name));
      }
    }
  }

  walk(resolvedDir);
  return results;
}

/**
 * Extract the original filename from a conflict file path
 * Pattern: filename.!sync -> filename.md
 */
function getOriginalPath(conflictPath) {
  return conflictPath.replace(/\.!sync$/, '.md');
}

/**
 * Check if two files have identical content
 */
function filesAreIdentical(file1, file2) {
  try {
    const stat1 = fs.statSync(file1);
    const stat2 = fs.statSync(file2);
    if (stat1.size !== stat2.size) return false;
    const buf1 = fs.readFileSync(file1);
    const buf2 = fs.readFileSync(file2);
    return buf1.equals(buf2);
  } catch {
    return false;
  }
}

/**
 * Main sync function
 */
function sync() {
  const conflictFiles = findConflictFiles(directory);

  if (conflictFiles.length === 0) {
    console.log(JSON.stringify({
      cleaned: 0,
      message: 'No Obsidian Sync conflict files found'
    }));
    return;
  }

  let cleaned = 0;
  let kept = 0;
  const actions = [];

  for (const conflictFile of conflictFiles) {
    const originalFile = getOriginalPath(conflictFile);
    const conflictBasename = path.basename(conflictFile);

    if (fs.existsSync(originalFile)) {
      if (filesAreIdentical(originalFile, conflictFile)) {
        // Files are identical - remove duplicate
        fs.unlinkSync(conflictFile);
        cleaned++;
        actions.push({ action: 'removed_duplicate', file: conflictBasename });
      } else {
        // Files differ - check timestamps
        const originalStat = fs.statSync(originalFile);
        const conflictStat = fs.statSync(conflictFile);

        if (conflictStat.mtimeMs < originalStat.mtimeMs) {
          // Conflict is older - remove it
          fs.unlinkSync(conflictFile);
          cleaned++;
          actions.push({ action: 'removed_older', file: conflictBasename });
        } else {
          // Conflict is newer - keep for manual review
          kept++;
          actions.push({ action: 'kept_newer', file: conflictBasename });
        }
      }
    } else {
      // Original doesn't exist - restore from conflict as .md
      fs.renameSync(conflictFile, originalFile);
      cleaned++;
      actions.push({ action: 'restored', file: path.basename(originalFile) });
    }
  }

  console.log(JSON.stringify({
    found: conflictFiles.length,
    cleaned,
    kept,
    actions
  }));
}

sync();
