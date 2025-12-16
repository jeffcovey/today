#!/usr/bin/env node

/**
 * iCloud Conflict Cleanup Plugin - Sync Command
 *
 * Cleans up duplicate files created by iCloud Drive sync.
 * Duplicate files have the pattern: filename 2.ext (or filename 3.ext, etc.)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Read settings from environment (set by plugin loader)
const directory = process.env.PLUGIN_SETTING_DIRECTORY || 'vault';

/**
 * Find all iCloud duplicate files in the directory
 * Pattern: "filename 2.ext" or "filename 3.ext" etc.
 * The space+digit must be immediately before the extension.
 */
function findDuplicateFiles(dir) {
  try {
    // Find files matching " N.ext" pattern for digits 2-9
    // Use multiple -name patterns since -name doesn't support character classes well
    // Use -L to follow symlinks (vault is often a symlink)
    const result = execSync(
      `find -L "${dir}" -type f \\( ` +
      `-name "* 2.*" -o -name "* 3.*" -o -name "* 4.*" -o ` +
      `-name "* 5.*" -o -name "* 6.*" -o -name "* 7.*" -o ` +
      `-name "* 8.*" -o -name "* 9.*" \\) 2>/dev/null`,
      { encoding: 'utf8' }
    );

    // Filter to only include files where the pattern is right before extension
    // Pattern: "name N.ext" where N is single digit and ext has no spaces
    const candidates = result.trim().split('\n').filter(f => f);
    return candidates.filter(f => {
      const basename = path.basename(f);
      // Match: any text + space + single digit + dot + extension (no spaces in ext)
      return /^.+ \d\.[^ ]+$/.test(basename);
    });
  } catch {
    return [];
  }
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
