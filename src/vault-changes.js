/**
 * Vault Changes - Core module for tracking file changes in the vault
 *
 * Reports files changed by comparing current state against stored checksums
 * in the database. Categorizes changes as:
 * - added: New files not in database
 * - modified: Files where content actually changed
 * - deleted: Files in database but no longer exist
 * - touched: Files where mtime changed but content is identical
 *
 * Usage:
 *   import { getChangedFiles, updateBaseline, getGitInfo } from './vault-changes.js';
 *
 *   // Get changes since last baseline
 *   const changes = getChangedFiles({ directory: 'vault' });
 *
 *   // Update baseline after processing
 *   updateBaseline({ directory: 'vault' });
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { getStartOfDayTimestamp } from './date-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, '.data/today.db');

// Default configuration
const DEFAULT_EXCLUDE_DIRS = new Set(['.sync', 'templates', '.git', '.git.nosync', '.obsidian', '.trash']);
const DEFAULT_SOURCE_ID = 'vault-changes/default';

/**
 * Get database connection
 */
function getDb() {
  return new Database(DB_PATH);
}

/**
 * Ensure the vault_files table exists
 */
function ensureTable(db) {
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
}

/**
 * Calculate MD5 checksum of file content
 */
export function calculateChecksum(filepath) {
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
export function findAllMarkdownFiles(dir, options = {}) {
  const excludeDirs = options.excludeDirs || DEFAULT_EXCLUDE_DIRS;
  const files = [];

  function scan(currentDir) {
    if (!fs.existsSync(currentDir)) return;

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (excludeDirs.has(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  scan(dir);
  return files;
}

/**
 * Extract title from markdown file content
 */
export function extractTitle(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8').slice(0, 500);
    const titleMatch = content.match(/^#\s+(.+)$/m);
    return titleMatch ? titleMatch[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Check if directory is a git repository
 */
function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git')) ||
         fs.existsSync(path.join(dir, '.git.nosync'));
}

/**
 * Run git command in directory, return output or null on error
 */
function git(dir, args) {
  try {
    return execSync(`git ${args}`, {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get git status information for a directory
 */
export function getGitInfo(dir) {
  if (!isGitRepo(dir)) return null;

  const info = {
    isRepo: true,
    branch: null,
    uncommitted: { staged: 0, unstaged: 0, untracked: 0 },
    unpushed: 0,
    todayCommits: []
  };

  // Current branch
  info.branch = git(dir, 'branch --show-current');

  // Uncommitted changes
  const status = git(dir, 'status --porcelain');
  if (status) {
    for (const line of status.split('\n')) {
      if (!line) continue;
      const index = line[0];
      const worktree = line[1];

      if (index === '?' && worktree === '?') {
        info.uncommitted.untracked++;
      } else {
        if (index !== ' ' && index !== '?') info.uncommitted.staged++;
        if (worktree !== ' ' && worktree !== '?') info.uncommitted.unstaged++;
      }
    }
  }

  // Unpushed commits (if tracking remote)
  const unpushed = git(dir, 'rev-list @{upstream}..HEAD --count 2>/dev/null');
  if (unpushed && !isNaN(parseInt(unpushed))) {
    info.unpushed = parseInt(unpushed);
  }

  // Commits made today
  const today = new Date().toISOString().split('T')[0];
  const todayLog = git(dir, `log --since="${today} 00:00:00" --format="%h|%s|%cr" --no-merges`);
  if (todayLog) {
    for (const line of todayLog.split('\n')) {
      if (!line) continue;
      const [hash, subject, relTime] = line.split('|');
      info.todayCommits.push({ hash, subject, relTime });
    }
  }

  return info;
}

/**
 * Get changed files from the vault
 *
 * @param {Object} options
 * @param {string} options.directory - Directory to scan (default: 'vault')
 * @param {Set<string>} options.excludeDirs - Directories to exclude
 * @param {string} options.sourceId - Source identifier for the baseline
 * @param {boolean} options.todayOnly - Only return files modified today (default: true)
 * @param {boolean} options.includeGit - Include git status information (default: true)
 * @param {boolean} options.autoInitBaseline - Auto-initialize baseline if missing (default: true)
 *
 * @returns {Object} Changes object with added, modified, deleted, touched arrays
 */
export function getChangedFiles(options = {}) {
  const directory = options.directory || 'vault';
  const excludeDirs = options.excludeDirs || DEFAULT_EXCLUDE_DIRS;
  const sourceId = options.sourceId || DEFAULT_SOURCE_ID;
  const todayOnly = options.todayOnly !== false;
  const includeGit = options.includeGit !== false;
  const autoInitBaseline = options.autoInitBaseline !== false;

  const db = getDb();
  ensureTable(db);

  // Get stored file data from database
  const storedFiles = db.prepare(`
    SELECT id, path, checksum, mtime_ms, title
    FROM vault_files
    WHERE source = ?
  `).all(sourceId);

  // Find all current markdown files
  const currentFiles = findAllMarkdownFiles(directory, { excludeDirs });

  // If no baseline exists and autoInit is enabled, create it
  if (storedFiles.length === 0 && autoInitBaseline) {
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
    db.close();

    return {
      initialized: true,
      count: 0,
      added: [],
      modified: [],
      deleted: [],
      touched: [],
      trackedFiles: count,
      git: includeGit ? getGitInfo(directory) : null
    };
  }

  const storedByPath = new Map(storedFiles.map(f => [f.path, f]));
  const currentFilesSet = new Set(currentFiles);

  // Get start of today for filtering
  const todayMidnightMs = todayOnly ? getStartOfDayTimestamp() : 0;

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

      // Only process files modified today (if todayOnly is true)
      if (todayOnly && stat.mtimeMs < todayMidnightMs) continue;

      const stored = storedByPath.get(filepath);

      if (!stored) {
        // New file - not in database
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

  // Sort each category by mtime (most recent first)
  changes.added.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  changes.modified.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  changes.touched.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));

  db.close();

  return {
    initialized: false,
    count: changes.added.length + changes.modified.length + changes.deleted.length + changes.touched.length,
    added: changes.added,
    modified: changes.modified,
    deleted: changes.deleted,
    touched: changes.touched,
    trackedFiles: storedFiles.length,
    git: includeGit ? getGitInfo(directory) : null
  };
}

/**
 * Update the baseline - store current file checksums in database
 *
 * @param {Object} options
 * @param {string} options.directory - Directory to scan (default: 'vault')
 * @param {Set<string>} options.excludeDirs - Directories to exclude
 * @param {string} options.sourceId - Source identifier for the baseline
 *
 * @returns {Object} Result with success status and file count
 */
export function updateBaseline(options = {}) {
  const directory = options.directory || 'vault';
  const excludeDirs = options.excludeDirs || DEFAULT_EXCLUDE_DIRS;
  const sourceId = options.sourceId || DEFAULT_SOURCE_ID;

  const db = getDb();
  ensureTable(db);

  // Find all markdown files
  const files = findAllMarkdownFiles(directory, { excludeDirs });

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
  db.close();

  return {
    success: true,
    fileCount: count,
    errors: errors > 0 ? errors : undefined
  };
}

/**
 * Get baseline status from database
 *
 * @param {Object} options
 * @param {string} options.sourceId - Source identifier for the baseline
 *
 * @returns {Object} Status with exists flag and file count
 */
export function getBaselineStatus(options = {}) {
  const sourceId = options.sourceId || DEFAULT_SOURCE_ID;

  const db = getDb();

  try {
    ensureTable(db);

    const result = db.prepare(`
      SELECT COUNT(*) as count, MAX(updated_at) as lastUpdated
      FROM vault_files
      WHERE source = ?
    `).get(sourceId);

    db.close();

    if (!result || result.count === 0) {
      return {
        exists: false
      };
    }

    return {
      exists: true,
      fileCount: result.count,
      lastUpdated: result.lastUpdated,
      sourceId
    };
  } catch (error) {
    db.close();
    return {
      exists: false,
      error: error.message
    };
  }
}

/**
 * Format changes as a context string for AI consumption
 */
export function formatChangesAsContext(changes, options = {}) {
  const lines = [];
  lines.push('### Vault Changes Today');
  lines.push('');

  if (changes.initialized) {
    lines.push(`Baseline initialized with ${changes.trackedFiles} files - tracking changes from now`);
    return lines.join('\n');
  }

  const totalChanges = changes.count;

  if (totalChanges === 0) {
    lines.push(`No changes detected (tracking ${changes.trackedFiles} files)`);
  } else {
    if (changes.added.length > 0) {
      lines.push(`**Added** (${changes.added.length}):`);
      for (const file of changes.added.slice(0, 10)) {
        lines.push(`- ${file.path}${file.title ? ': ' + file.title : ''}`);
      }
      if (changes.added.length > 10) lines.push(`- ... and ${changes.added.length - 10} more`);
      lines.push('');
    }

    if (changes.modified.length > 0) {
      lines.push(`**Modified** (${changes.modified.length}):`);
      for (const file of changes.modified.slice(0, 10)) {
        lines.push(`- ${file.path}${file.title ? ': ' + file.title : ''}`);
      }
      if (changes.modified.length > 10) lines.push(`- ... and ${changes.modified.length - 10} more`);
      lines.push('');
    }

    if (changes.deleted.length > 0) {
      lines.push(`**Deleted** (${changes.deleted.length}):`);
      for (const file of changes.deleted.slice(0, 10)) {
        lines.push(`- ${file.path}${file.title ? ': ' + file.title : ''}`);
      }
      if (changes.deleted.length > 10) lines.push(`- ... and ${changes.deleted.length - 10} more`);
      lines.push('');
    }

    if (changes.touched.length > 0) {
      lines.push(`**Touched** (mtime changed, content same): ${changes.touched.length} file(s)`);
    }
  }

  // Add git information if available
  if (changes.git) {
    const gitInfo = changes.git;
    lines.push('');
    lines.push('### Git Status');
    lines.push('');
    lines.push(`Branch: \`${gitInfo.branch || 'unknown'}\``);

    const { staged, unstaged, untracked } = gitInfo.uncommitted;
    const uncommittedTotal = staged + unstaged + untracked;
    if (uncommittedTotal > 0) {
      const parts = [];
      if (staged > 0) parts.push(`${staged} staged`);
      if (unstaged > 0) parts.push(`${unstaged} unstaged`);
      if (untracked > 0) parts.push(`${untracked} untracked`);
      lines.push(`**Uncommitted changes:** ${parts.join(', ')}`);
    } else {
      lines.push('Working tree clean');
    }

    if (gitInfo.unpushed > 0) {
      lines.push(`**Unpushed commits:** ${gitInfo.unpushed}`);
    }

    if (gitInfo.todayCommits.length > 0) {
      lines.push('');
      lines.push(`**Commits today** (${gitInfo.todayCommits.length}):`);
      for (const commit of gitInfo.todayCommits.slice(0, 5)) {
        lines.push(`- \`${commit.hash}\` ${commit.subject} (${commit.relTime})`);
      }
      if (gitInfo.todayCommits.length > 5) {
        lines.push(`- ... and ${gitInfo.todayCommits.length - 5} more`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Get all changed file paths (convenience function for plugins)
 * Returns just the paths of added and modified files
 */
export function getChangedFilePaths(options = {}) {
  const changes = getChangedFiles(options);
  return [
    ...changes.added.map(f => f.path),
    ...changes.modified.map(f => f.path)
  ];
}
