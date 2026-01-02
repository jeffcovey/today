#!/usr/bin/env node

/**
 * Resilio Conflict Cleanup Plugin - Sync Command
 *
 * Cleans up sync conflict files created by Resilio Sync.
 * Conflict files have the pattern: filename.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.ext
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Read settings from environment (set by plugin loader)
const directory = process.env.PLUGIN_SETTING_DIRECTORY || process.env.VAULT_PATH;

/**
 * Find all sync-conflict files in the directory
 */
function findConflictFiles(dir) {
  try {
    const result = execSync(`find "${dir}" -name "*sync-conflict-*" -type f 2>/dev/null`, {
      encoding: 'utf8'
    });
    return result.trim().split('\n').filter(f => f);
  } catch {
    return [];
  }
}

/**
 * Extract the original filename from a conflict file path
 * Pattern: filename.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.ext
 */
function getOriginalPath(conflictPath) {
  return conflictPath.replace(/\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}/, '');
}

/**
 * Check if two files have identical content
 */
function filesAreIdentical(file1, file2) {
  try {
    execSync(`diff -q "${file1}" "${file2}"`, { stdio: 'ignore' });
    return true;
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
      message: 'No sync-conflict files found'
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
      // Original doesn't exist - restore from conflict
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
