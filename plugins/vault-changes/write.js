#!/usr/bin/env node

/**
 * Vault Changes Plugin - Write Command
 *
 * Handles write operations for the vault-changes plugin.
 * Primary action: update-baseline - saves current file checksums to database
 *
 * Input: ENTRY_JSON environment variable with action data
 * Output: JSON with success status
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

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
 * Update baseline - store current file checksums in database
 */
function updateBaseline() {
  const db = getDb();

  // Ensure table exists
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

  // Find all markdown files
  const files = findAllMarkdownFiles(directory);

  // Prepare statements
  const upsert = db.prepare(`
    INSERT INTO vault_files (id, source, path, checksum, mtime_ms, title, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      checksum = excluded.checksum,
      mtime_ms = excluded.mtime_ms,
      title = excluded.title,
      updated_at = CURRENT_TIMESTAMP
  `);

  const deleteStmt = db.prepare(`
    DELETE FROM vault_files WHERE source = ? AND path = ?
  `);

  // Get existing files for this source
  const existingFiles = db.prepare(`
    SELECT path FROM vault_files WHERE source = ?
  `).all(sourceId);
  const existingPaths = new Set(existingFiles.map(f => f.path));

  // Track current files
  const currentPaths = new Set();
  let count = 0;
  let errors = 0;

  // Update/insert all current files
  const updateAll = db.transaction(() => {
    for (const filepath of files) {
      const checksum = calculateChecksum(filepath);
      if (checksum) {
        try {
          const stat = fs.statSync(filepath);
          const id = `${sourceId}:${filepath}`;
          upsert.run(id, sourceId, filepath, checksum, stat.mtimeMs, extractTitle(filepath));
          currentPaths.add(filepath);
          count++;
        } catch {
          errors++;
        }
      } else {
        errors++;
      }
    }

    // Remove files that no longer exist
    for (const existingPath of existingPaths) {
      if (!currentPaths.has(existingPath)) {
        deleteStmt.run(sourceId, existingPath);
      }
    }
  });

  updateAll();

  return {
    success: true,
    message: `Baseline updated: ${count} files tracked`,
    fileCount: count,
    errors: errors > 0 ? errors : undefined
  };
}

/**
 * Get baseline status from database
 */
function getBaselineStatus() {
  const db = getDb();

  try {
    const result = db.prepare(`
      SELECT COUNT(*) as count, MAX(updated_at) as lastUpdated
      FROM vault_files
      WHERE source = ?
    `).get(sourceId);

    if (!result || result.count === 0) {
      return {
        success: true,
        exists: false,
        message: 'No baseline exists yet'
      };
    }

    return {
      success: true,
      exists: true,
      fileCount: result.count,
      lastUpdated: result.lastUpdated,
      source: sourceId
    };
  } catch (error) {
    return {
      success: false,
      error: `Error reading baseline: ${error.message}`
    };
  }
}

// Handle actions
let result;
switch (action) {
  case 'update-baseline':
    result = updateBaseline();
    break;
  case 'status':
    result = getBaselineStatus();
    break;
  default:
    result = { success: false, error: `Unknown action: ${action}` };
}

console.log(JSON.stringify(result));
