/**
 * Database Health Check and Recovery
 *
 * Provides shared functionality for checking database health and
 * recreating it if necessary. Used by bin/today and bin/sync.
 *
 * The database is treated as a local cache that can be rebuilt from
 * external sources via bin/sync. If corrupted or outdated, we delete
 * and recreate rather than trying to recover - all data can be re-synced.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { MigrationManager } from './migrations.js';

const DATA_DIR = '.data';
const DB_PATH = '.data/today.db';
const BACKUP_PATH = '.data/today.db.backup';
const WAL_PATH = '.data/today.db-wal';
const SHM_PATH = '.data/today.db-shm';

// Cleanup configuration
const MAX_BACKUPS = 5;
const MAX_DATA_SIZE_MB = 500;
const SYNC_METADATA_RETENTION_DAYS = 90;

// Tables that indicate a legacy database needing rebuild
// These are tables from the old schema that don't exist in the new plugin-based system
// Note: cache_metadata and database_cache are still used by bin/email CLI
const LEGACY_TABLES = [
  'todoist_sync_mapping',
  'markdown_sync',
];

/**
 * Clean up orphaned WAL/SHM files when main database is missing.
 * These files can cause undefined SQLite behavior if left behind.
 * @returns {boolean} True if any orphaned files were cleaned up
 */
function cleanOrphanedWalFiles() {
  let cleaned = false;
  for (const filePath of [WAL_PATH, SHM_PATH]) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        cleaned = true;
      } catch {
        // Ignore deletion errors
      }
    }
  }
  return cleaned;
}

/**
 * Check if the database exists and has the required schema
 * @returns {Object} { healthy: boolean, reason?: string, version?: number, corrupted?: boolean }
 */
export function checkDatabaseHealth() {
  // Check if database file exists
  if (!fs.existsSync(DB_PATH)) {
    // Clean up orphaned WAL/SHM files if they exist.
    // These can cause undefined SQLite behavior when creating a new database.
    const hadOrphanedFiles = cleanOrphanedWalFiles();
    const reason = hadOrphanedFiles
      ? 'Database file does not exist (cleaned orphaned WAL/SHM files)'
      : 'Database file does not exist';
    return { healthy: false, reason };
  }

  // Note: We previously checked for "empty WAL + SHM" as corruption indicator,
  // but this is actually a normal state after wal_checkpoint(TRUNCATE).
  // The real test for corruption is the integrity_check pragma below.

  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });

    // Test that we can actually query the database (detects disk I/O errors)
    try {
      db.prepare('SELECT 1').get();
    } catch (queryError) {
      db.close();
      return {
        healthy: false,
        corrupted: true,
        reason: `Database query failed: ${queryError.message}`
      };
    }

    // Run integrity check
    try {
      const integrityResult = db.prepare('PRAGMA integrity_check').get();
      if (integrityResult?.integrity_check !== 'ok') {
        db.close();
        return {
          healthy: false,
          corrupted: true,
          reason: `Integrity check failed: ${integrityResult?.integrity_check}`
        };
      }
    } catch (integrityError) {
      db.close();
      return {
        healthy: false,
        corrupted: true,
        reason: `Integrity check error: ${integrityError.message}`
      };
    }

    // Check if schema_version table exists
    const schemaTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get();

    if (!schemaTable) {
      db.close();
      return { healthy: false, reason: 'Missing schema_version table' };
    }

    // Check for legacy tables that indicate old schema
    const legacyTableCheck = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${LEGACY_TABLES.map(() => '?').join(',')})`
    ).all(...LEGACY_TABLES);

    if (legacyTableCheck.length > 0) {
      const foundTables = legacyTableCheck.map(r => r.name).join(', ');
      db.close();
      return {
        healthy: false,
        reason: `Legacy tables found: ${foundTables}`,
      };
    }

    // Get current schema version
    const versionResult = db.prepare('SELECT MAX(version) as version FROM schema_version').get();
    const version = versionResult?.version || 0;

    db.close();
    return { healthy: true, version };
  } catch (error) {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    // Treat connection errors as corruption
    const isCorruption = error.message.includes('disk I/O error') ||
                         error.message.includes('database disk image is malformed') ||
                         error.message.includes('file is not a database');
    return {
      healthy: false,
      corrupted: isCorruption,
      reason: `Database error: ${error.message}`
    };
  }
}

/**
 * Create a backup of the current database
 * @returns {boolean} Success status
 */
export function backupDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    return false;
  }

  try {
    // Add timestamp to backup name to preserve multiple backups
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const timestampedBackup = `.data/today.db.backup-${timestamp}`;

    // Copy to timestamped backup
    fs.copyFileSync(DB_PATH, timestampedBackup);

    // Also maintain the standard backup path (most recent)
    fs.copyFileSync(DB_PATH, BACKUP_PATH);

    return true;
  } catch (error) {
    console.error(`Failed to backup database: ${error.message}`);
    return false;
  }
}

/**
 * Remove database files including WAL and SHM
 */
function removeAllDatabaseFiles() {
  for (const filePath of [DB_PATH, WAL_PATH, SHM_PATH]) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore deletion errors
      }
    }
  }
}

/**
 * Create a fresh database with the current schema
 * @returns {Promise<boolean>} Success status
 */
export async function createFreshDatabase() {
  // Ensure directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Remove existing database AND WAL/SHM files
  removeAllDatabaseFiles();

  let db;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    // Run migrations
    const migrationManager = new MigrationManager(db);
    await migrationManager.runMigrations();

    db.close();
    return true;
  } catch (error) {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    console.error(`Failed to create database: ${error.message}`);
    return false;
  }
}

/**
 * Check database health and recreate if necessary
 * This is the main entry point for bin/today and bin/sync
 *
 * @param {Object} options
 * @param {boolean} options.verbose - Print status messages
 * @param {boolean} options.forceRecreate - Force database recreation
 * @returns {Promise<Object>} { success: boolean, recreated: boolean, message: string }
 */
export async function ensureHealthyDatabase(options = {}) {
  const { verbose = true, forceRecreate = false } = options;

  const log = (msg) => { if (verbose) console.log(msg); };
  const warn = (msg) => { if (verbose) console.log(`⚠️  ${msg}`); };
  const success = (msg) => { if (verbose) console.log(`✅ ${msg}`); };
  const error = (msg) => { if (verbose) console.error(`❌ ${msg}`); };

  // Check current health
  const health = checkDatabaseHealth();

  if (health.healthy && !forceRecreate) {
    // Database is healthy, but check if there are new migrations to apply
    try {
      const db = new Database(DB_PATH);
      const migrationManager = new MigrationManager(db, { verbose });
      const startVersion = migrationManager.getCurrentVersion();
      await migrationManager.runMigrations();
      const endVersion = migrationManager.getCurrentVersion();
      db.close();

      if (endVersion > startVersion) {
        log(`✅ Database migrated from version ${startVersion} to ${endVersion}`);
      }
    } catch (migrationError) {
      error(`Migration failed: ${migrationError.message}`);
      return { success: false, recreated: false, message: `Migration failed: ${migrationError.message}` };
    }
    return { success: true, recreated: false, message: 'Database is healthy' };
  }

  // Database needs recreation
  const reason = forceRecreate ? 'Force recreate requested' : health.reason;
  warn(`Database needs recreation: ${reason}`);

  // Only backup if NOT corrupted (corrupted backups are useless)
  if (fs.existsSync(DB_PATH) && !health.corrupted) {
    log('📦 Backing up existing database...');
    if (backupDatabase()) {
      log('   Backup created at .data/today.db.backup');
    } else {
      warn('   Could not create backup');
    }
  } else if (health.corrupted) {
    log('⚠️  Skipping backup of corrupted database');
  }

  // Create fresh database
  log('🔨 Creating fresh database...');
  if (await createFreshDatabase()) {
    success('Database created successfully');
    log('ℹ️  Database is a local cache - data will be populated from sync');

    // Run cleanup after successful recreation
    runCleanup({ verbose });

    return { success: true, recreated: true, message: 'Database recreated' };
  } else {
    error('Failed to create database');
    return { success: false, recreated: false, message: 'Database creation failed' };
  }
}

/**
 * Get the current schema version
 * @returns {number} Schema version or 0 if not available
 */
export function getSchemaVersion() {
  const health = checkDatabaseHealth();
  return health.version || 0;
}

// ============================================================================
// Database Cleanup Functions
// ============================================================================

/**
 * Get all files in the data directory with their sizes
 */
function getDataFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];

  const files = [];
  for (const name of fs.readdirSync(DATA_DIR)) {
    const filePath = path.join(DATA_DIR, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        files.push({
          name,
          path: filePath,
          size: stat.size,
          sizeMB: stat.size / 1024 / 1024
        });
      }
    } catch {
      // Skip files we can't stat
    }
  }
  return files;
}

/**
 * Clean up old backup files, keeping only the most recent ones
 * @returns {Object} { deleted: number, freedMB: number }
 */
export function cleanOldBackups() {
  const allFiles = getDataFiles();
  const backupFiles = allFiles
    .filter(f => f.name.match(/\.db\.backup-/))
    .map(f => ({
      ...f,
      timestamp: f.name.match(/\.backup-(.+)$/)?.[1] || ''
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)); // Oldest first

  let currentSizeMB = allFiles.reduce((sum, f) => sum + f.sizeMB, 0);
  let freedMB = 0;
  let deleted = 0;

  // Delete by count (keep MAX_BACKUPS most recent)
  if (backupFiles.length > MAX_BACKUPS) {
    const toDelete = backupFiles.slice(0, backupFiles.length - MAX_BACKUPS);
    for (const file of toDelete) {
      try {
        fs.unlinkSync(file.path);
        currentSizeMB -= file.sizeMB;
        freedMB += file.sizeMB;
        deleted++;
      } catch {
        // Skip
      }
    }
  }

  // Delete by total size (if still over limit)
  if (currentSizeMB > MAX_DATA_SIZE_MB) {
    const remainingBackups = getDataFiles()
      .filter(f => f.name.match(/\.db\.backup-/))
      .sort((a, b) => (a.name.match(/\.backup-(.+)$/)?.[1] || '').localeCompare(
        b.name.match(/\.backup-(.+)$/)?.[1] || ''
      ));

    for (const file of remainingBackups) {
      if (currentSizeMB <= MAX_DATA_SIZE_MB) break;
      try {
        fs.unlinkSync(file.path);
        currentSizeMB -= file.sizeMB;
        freedMB += file.sizeMB;
        deleted++;
      } catch {
        // Skip
      }
    }
  }

  return { deleted, freedMB: Math.round(freedMB * 10) / 10 };
}

/**
 * VACUUM the database to reclaim space
 * @returns {Object} { success: boolean, freedMB: number }
 */
export function vacuumDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    return { success: false, freedMB: 0 };
  }

  let db;
  try {
    const sizeBefore = fs.statSync(DB_PATH).size;
    db = new Database(DB_PATH);
    db.pragma('vacuum');
    db.close();
    const sizeAfter = fs.statSync(DB_PATH).size;
    const freedMB = (sizeBefore - sizeAfter) / 1024 / 1024;

    return {
      success: true,
      freedMB: Math.max(0, Math.round(freedMB * 10) / 10)
    };
  } catch (error) {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    return { success: false, freedMB: 0 };
  }
}

/**
 * Prune old sync_metadata entries
 * @returns {number} Number of entries deleted
 */
export function pruneSyncMetadata() {
  if (!fs.existsSync(DB_PATH)) return 0;

  let db;
  try {
    db = new Database(DB_PATH);

    // Check if table exists
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_metadata'"
    ).get();

    if (!tableExists) {
      db.close();
      return 0;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - SYNC_METADATA_RETENTION_DAYS);
    const cutoff = cutoffDate.toISOString();

    const result = db.prepare(
      "DELETE FROM sync_metadata WHERE last_synced_at < ?"
    ).run(cutoff);

    db.close();
    return result.changes;
  } catch {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    return 0;
  }
}

/**
 * Run all cleanup tasks
 * @param {Object} options
 * @param {boolean} options.verbose - Print status messages
 * @returns {Object} Summary of cleanup actions
 */
export function runCleanup(options = {}) {
  const { verbose = false } = options;
  const log = (msg) => { if (verbose) console.log(msg); };

  const results = {
    backups: { deleted: 0, freedMB: 0 },
    vacuum: { success: false, freedMB: 0 },
    syncMetadata: { pruned: 0 }
  };

  // Clean old backups
  results.backups = cleanOldBackups();
  if (results.backups.deleted > 0) {
    log(`🗑️  Cleaned ${results.backups.deleted} old backup(s), freed ${results.backups.freedMB} MB`);
  }

  // Vacuum database
  results.vacuum = vacuumDatabase();
  if (results.vacuum.freedMB > 0) {
    log(`🧹 Vacuumed database, freed ${results.vacuum.freedMB} MB`);
  }

  // Prune old sync metadata
  results.syncMetadata.pruned = pruneSyncMetadata();
  if (results.syncMetadata.pruned > 0) {
    log(`📋 Pruned ${results.syncMetadata.pruned} old sync metadata entries`);
  }

  return results;
}
