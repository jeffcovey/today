#!/usr/bin/env node

/**
 * Vault Changes Plugin - Read Command
 *
 * Reports files changed or added today in the vault.
 * Uses timezone-aware date utilities for accurate "today" calculation.
 */

import fs from 'fs';
import path from 'path';
import { getStartOfDayTimestamp, getConfiguredTimezone } from '../../src/date-utils.js';

// Read settings from environment (set by plugin loader)
const directory = process.env.PLUGIN_SETTING_DIRECTORY || 'vault';
const excludeDirsStr = process.env.PLUGIN_SETTING_EXCLUDEDIRS || '.sync,templates,.git,.git.nosync,.obsidian,.trash';
const excludeDirs = new Set(excludeDirsStr.split(',').map(d => d.trim()));

/**
 * Recursively find markdown files modified today
 */
function findChangedFiles(dir, todayMidnightTs, files = []) {
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (excludeDirs.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      findChangedFiles(fullPath, todayMidnightTs, files);
    } else if (entry.name.endsWith('.md')) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= todayMidnightTs) {
          files.push({
            path: fullPath,
            mtimeMs: stat.mtimeMs
          });
        }
      } catch {
        // Ignore errors (file might have been deleted)
      }
    }
  }

  return files;
}

/**
 * Extract title from markdown file content
 */
function extractTitle(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8').slice(0, 500);
    const titleMatch = content.match(/^#\s+(.+)$/m);
    return titleMatch ? titleMatch[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Main read function
 */
function read() {
  const timezone = getConfiguredTimezone();
  const todayMidnightTs = getStartOfDayTimestamp(timezone);

  const files = findChangedFiles(directory, todayMidnightTs);

  if (files.length === 0) {
    console.log(JSON.stringify({
      count: 0,
      files: [],
      message: 'No files changed today'
    }));
    return;
  }

  // Sort by modification time (most recent first)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Extract titles and format output
  const results = files.map(file => {
    const title = extractTitle(file.path);
    return {
      path: file.path,
      title: title,
      mtimeMs: file.mtimeMs
    };
  });

  console.log(JSON.stringify({
    count: files.length,
    files: results
  }));
}

read();
