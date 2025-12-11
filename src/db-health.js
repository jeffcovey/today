/**
 * Database Health Check and Recovery
 *
 * Provides shared functionality for checking database health and
 * recreating it if necessary. Used by bin/today and bin/sync.
 *
 * The database is treated as a local cache that can be rebuilt from
 * external sources via bin/sync. If the schema is outdated or incompatible,
 * we backup and recreate rather than trying to migrate legacy data.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { MigrationManager } from './migrations.js';

const DB_PATH = '.data/today.db';
const BACKUP_PATH = '.data/today.db.backup';

// Tables that indicate a legacy database needing rebuild
// These are tables from the old schema that don't exist in the new plugin-based system
const LEGACY_TABLES = [
  'todoist_sync_mapping',
  'markdown_sync',
  'ogm_github_issues',
  'ogm_sentry_issues',
  'cache_metadata',
  'database_cache',
];

/**
 * Check if the database exists and has the required schema
 * @returns {Object} { healthy: boolean, reason?: string, version?: number }
 */
export function checkDatabaseHealth() {
  // Check if database file exists
  if (!fs.existsSync(DB_PATH)) {
    return { healthy: false, reason: 'Database file does not exist' };
  }

  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });

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
    return { healthy: false, reason: `Database error: ${error.message}` };
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
 * Create a fresh database with the current schema
 * @returns {Promise<boolean>} Success status
 */
export async function createFreshDatabase() {
  // Ensure directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Remove existing database if present
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }

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

  // Backup existing database if it exists
  if (fs.existsSync(DB_PATH)) {
    log('📦 Backing up existing database...');
    if (backupDatabase()) {
      log('   Backup created at .data/today.db.backup');
    } else {
      warn('   Could not create backup');
    }
  }

  // Create fresh database
  log('🔨 Creating fresh database...');
  if (await createFreshDatabase()) {
    success('Database created successfully');
    log('ℹ️  Database is a local cache - data will be populated from sync');
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
