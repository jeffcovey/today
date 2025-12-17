#!/usr/bin/env node

/**
 * Vault Changes Plugin - Read Command
 *
 * Reports files changed in the vault by comparing current state against
 * stored checksums in the database. Categorizes changes as:
 * - added: New files not in database
 * - modified: Files where content actually changed
 * - deleted: Files in database but no longer exist
 * - touched: Files where mtime changed but content is identical
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getStartOfDayTimestamp } from '../../src/date-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.join(PROJECT_ROOT, '.data/today.db');

/**
 * Get database connection (direct, without dotenvx logging)
 */
function getDb() {
  return new Database(DB_PATH);
}

// Read settings from environment (set by plugin loader)
const directory = process.env.PLUGIN_SETTING_DIRECTORY || 'vault';
const excludeDirsStr = process.env.PLUGIN_SETTING_EXCLUDEDIRS || '.sync,templates,.git,.git.nosync,.obsidian,.trash';
const excludeDirs = new Set(excludeDirsStr.split(',').map(d => d.trim()));
const sourceId = process.env.SOURCE_ID || 'vault-changes/default';

/**
 * Calculate MD5 checksum of file content
 */
function calculateChecksum(filepath) {
  try {
    const content = fs.readFileSync(filepath);
    return crypto.createHash('md5').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Recursively find all markdown files
 */
function findAllMarkdownFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (excludeDirs.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      findAllMarkdownFiles(fullPath, files);
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
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
  const db = getDb();

  // Ensure table exists (migration should have created it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_files (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      path TEXT NOT NULL,
      checksum TEXT NOT NULL,
      mtime_ms INTEGER,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get stored file data from database
  const storedFiles = db.prepare(`
    SELECT id, path, checksum, mtime_ms, title
    FROM vault_files
    WHERE source = ?
  `).all(sourceId);

  // Find all current markdown files
  const currentFiles = findAllMarkdownFiles(directory);

  // If no baseline exists, create it automatically
  if (storedFiles.length === 0) {
    const upsert = db.prepare(`
      INSERT INTO vault_files (id, source, path, checksum, mtime_ms, title, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    let count = 0;
    const initBaseline = db.transaction(() => {
      for (const filepath of currentFiles) {
        const checksum = calculateChecksum(filepath);
        if (checksum) {
          try {
            const stat = fs.statSync(filepath);
            const id = `${sourceId}:${filepath}`;
            upsert.run(id, sourceId, filepath, checksum, stat.mtimeMs, extractTitle(filepath));
            count++;
          } catch {
            // Skip files we can't read
          }
        }
      }
    });

    initBaseline();

    console.log(JSON.stringify({
      context: `### Vault Changes Today\n\nBaseline initialized with ${count} files - tracking changes from now`,
      mode: 'initialized',
      count: 0,
      added: [],
      modified: [],
      deleted: [],
      touched: [],
      trackedFiles: count,
      message: `Baseline initialized with ${count} files - tracking changes from now`
    }));
    return;
  }

  const storedByPath = new Map(storedFiles.map(f => [f.path, f]));
  const currentFilesSet = new Set(currentFiles);

  // Get start of today for filtering
  const todayMidnightMs = getStartOfDayTimestamp();

  const changes = {
    added: [],
    modified: [],
    deleted: [],
    touched: []
  };

  // Check each current file against stored data
  for (const filepath of currentFiles) {
    try {
      const stat = fs.statSync(filepath);

      // Only process files modified today
      if (stat.mtimeMs < todayMidnightMs) continue;

      const stored = storedByPath.get(filepath);

      if (!stored) {
        // New file - not in database
        // Only include if we can actually read it (skip iCloud sync issues)
        const checksum = calculateChecksum(filepath);
        if (checksum) {
          changes.added.push({
            path: filepath,
            mtimeMs: stat.mtimeMs,
            title: extractTitle(filepath)
          });
        }
      } else if (stat.mtimeMs !== stored.mtime_ms) {
        // Mtime differs - check if content actually changed
        const currentChecksum = calculateChecksum(filepath);

        if (currentChecksum !== stored.checksum) {
          // Content actually changed
          changes.modified.push({
            path: filepath,
            mtimeMs: stat.mtimeMs,
            title: extractTitle(filepath),
            previousTitle: stored.title
          });
        } else {
          // Mtime changed but content identical
          changes.touched.push({
            path: filepath,
            mtimeMs: stat.mtimeMs,
            title: extractTitle(filepath)
          });
        }
      }
      // If mtime matches, assume unchanged (skip)
    } catch {
      // Ignore errors
    }
  }

  // Check for deleted files (in database but not on disk)
  for (const stored of storedFiles) {
    if (!currentFilesSet.has(stored.path)) {
      changes.deleted.push({
        path: stored.path,
        title: stored.title
      });
    }
  }

  const totalChanges = changes.added.length + changes.modified.length +
                       changes.deleted.length + changes.touched.length;

  // Sort each category by mtime (most recent first)
  changes.added.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  changes.modified.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  changes.touched.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));

  // Build context string for AI consumption
  const contextLines = [];
  contextLines.push('### Vault Changes Today');
  contextLines.push('');

  if (totalChanges === 0) {
    contextLines.push(`No changes detected (tracking ${storedFiles.length} files)`);
  } else {
    if (changes.added.length > 0) {
      contextLines.push(`**Added** (${changes.added.length}):`);
      for (const file of changes.added.slice(0, 10)) {
        contextLines.push(`- ${file.path}${file.title ? ': ' + file.title : ''}`);
      }
      if (changes.added.length > 10) contextLines.push(`- ... and ${changes.added.length - 10} more`);
      contextLines.push('');
    }

    if (changes.modified.length > 0) {
      contextLines.push(`**Modified** (${changes.modified.length}):`);
      for (const file of changes.modified.slice(0, 10)) {
        contextLines.push(`- ${file.path}${file.title ? ': ' + file.title : ''}`);
      }
      if (changes.modified.length > 10) contextLines.push(`- ... and ${changes.modified.length - 10} more`);
      contextLines.push('');
    }

    if (changes.deleted.length > 0) {
      contextLines.push(`**Deleted** (${changes.deleted.length}):`);
      for (const file of changes.deleted.slice(0, 10)) {
        contextLines.push(`- ${file.path}${file.title ? ': ' + file.title : ''}`);
      }
      if (changes.deleted.length > 10) contextLines.push(`- ... and ${changes.deleted.length - 10} more`);
      contextLines.push('');
    }

    if (changes.touched.length > 0) {
      contextLines.push(`**Touched** (mtime changed, content same): ${changes.touched.length} file(s)`);
    }
  }

  console.log(JSON.stringify({
    context: contextLines.join('\n'),
    mode: 'content-aware',
    count: totalChanges,
    added: changes.added,
    modified: changes.modified,
    deleted: changes.deleted,
    touched: changes.touched,
    trackedFiles: storedFiles.length,
    message: `${totalChanges} change(s) detected`
  }));
}

read();
