#!/usr/bin/env node

/**
 * iCloud Conflict Cleanup Plugin - Sync Command
 *
 * Cleans up duplicate files created by iCloud Drive sync.
 * Duplicate files have the pattern: filename 2.ext (or filename 3.ext, etc.)
 */

import fs from 'fs';
import path from 'path';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

const directory = path.join(projectRoot, config.directory || process.env.VAULT_PATH || 'vault');

// Match: any text + space + single digit + dot + extension (no spaces in ext)
const DUPLICATE_PATTERN = /^.+ \d\.[^ ]+$/;

const skipDirsDefault = 'node_modules,.git,.git.nosync,.sync,.obsidian,.stfolder,.stversions,.backups,_tmp';
const SKIP_DIRS = new Set(
  (config.skip_directories || skipDirsDefault).split(',').map(s => s.trim())
);

/**
 * Find all iCloud duplicate files in the directory
 * Pattern: "filename 2.ext" or "filename 3.ext" etc.
 * The space+digit must be immediately before the extension.
 */
function findDuplicateFiles(dir) {
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
      } else if (entry.isFile() && DUPLICATE_PATTERN.test(entry.name)) {
        results.push(path.join(currentDir, entry.name));
      }
    }
  }

  walk(resolvedDir);
  return results;
}

/**
 * Extract the original filename from a duplicate file path
 * Pattern: "filename 2.ext" -> "filename.ext"
 */
function getOriginalPath(duplicatePath) {
  const dir = path.dirname(duplicatePath);
  const basename = path.basename(duplicatePath);

  // Match pattern: "name 2.ext" or "name 3.ext" etc.
  const match = basename.match(/^(.+) \d+(\.[^.]+)$/);
  if (match) {
    return path.join(dir, match[1] + match[2]);
  }
  return null;
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
  const duplicateFiles = findDuplicateFiles(directory);

  if (duplicateFiles.length === 0) {
    console.log(JSON.stringify({
      cleaned: 0,
      message: 'No iCloud duplicate files found'
    }));
    return;
  }

  let cleaned = 0;
  let kept = 0;
  const actions = [];

  for (const duplicateFile of duplicateFiles) {
    const originalFile = getOriginalPath(duplicateFile);
    const duplicateBasename = path.basename(duplicateFile);

    if (!originalFile) {
      // Couldn't parse the pattern - skip
      kept++;
      actions.push({ action: 'skipped_unknown_pattern', file: duplicateBasename });
      continue;
    }

    if (fs.existsSync(originalFile)) {
      if (filesAreIdentical(originalFile, duplicateFile)) {
        // Files are identical - remove duplicate
        fs.unlinkSync(duplicateFile);
        cleaned++;
        actions.push({ action: 'removed_duplicate', file: duplicateBasename });
      } else {
        // Files differ - check timestamps
        const originalStat = fs.statSync(originalFile);
        const duplicateStat = fs.statSync(duplicateFile);

        if (duplicateStat.mtimeMs < originalStat.mtimeMs) {
          // Duplicate is older - remove it
          fs.unlinkSync(duplicateFile);
          cleaned++;
          actions.push({ action: 'removed_older', file: duplicateBasename });
        } else {
          // Duplicate is newer - keep for manual review
          kept++;
          actions.push({ action: 'kept_newer', file: duplicateBasename });
        }
      }
    } else {
      // Original doesn't exist - restore from duplicate
      fs.renameSync(duplicateFile, originalFile);
      cleaned++;
      actions.push({ action: 'restored', file: path.basename(originalFile) });
    }
  }

  console.log(JSON.stringify({
    found: duplicateFiles.length,
    cleaned,
    kept,
    actions
  }));
}

sync();
