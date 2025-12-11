// Database migration system for schema versioning
// Schema definitions are in plugin-schemas.js (single source of truth)

import { schemas, getSqlColumns, getTableName, getIndexes } from './plugin-schemas.js';

/**
 * System migrations (not tied to plugin types)
 */
const systemMigrations = [
  {
    version: 100,  // Use high numbers for system tables to avoid conflicts
    description: 'Create sync_metadata table for tracking plugin sync state',
    fn: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_metadata (
          source TEXT PRIMARY KEY,
          last_synced_at DATETIME,
          last_sync_files TEXT,
          entries_count INTEGER DEFAULT 0
        )
      `);
    }
  }
];

/**
 * Build migrations from plugin type schemas
 * Each schema becomes a numbered migration in order of definition
 */
function buildMigrations() {
  const pluginMigrations = Object.keys(schemas).map((type, index) => {
    const table = getTableName(type);
    const columns = getSqlColumns(type);
    const indexes = getIndexes(type);

    return {
      version: index + 1,
      description: `Create ${table} table for ${type} plugin type`,
      fn: (db) => {
        db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      ${columns}
    )`);
        for (const col of indexes) {
          db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_${col} ON ${table}(${col})`);
        }
      }
    };
  });

  // Combine plugin and system migrations, sorted by version
  return [...pluginMigrations, ...systemMigrations].sort((a, b) => a.version - b.version);
}

export class MigrationManager {
  constructor(db, options = {}) {
    this.db = db;
    this.verbose = options.verbose ?? true;
    this.initMigrationTable();
  }

  initMigrationTable() {
    // Create schema_version table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        description TEXT
      )
    `);
  }

  getCurrentVersion() {
    const result = this.db.prepare('SELECT MAX(version) as version FROM schema_version').get();
    return result?.version || 0;
  }

  async applyMigration(version, description, migrationFn) {
    const currentVersion = this.getCurrentVersion();

    if (version <= currentVersion) {
      return false;
    }

    if (this.verbose) {
      console.log(`  Applying migration ${version}: ${description}`);
    }

    try {
      // Run migration in a transaction
      this.db.transaction(() => {
        migrationFn(this.db);

        // Record the migration
        this.db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
          .run(version, description);
      })();

      if (this.verbose) {
        console.log(`  Migration ${version} applied successfully`);
      }
      return true;
    } catch (error) {
      console.error(`  Migration ${version} failed:`, error.message);
      throw error;
    }
  }

  async runMigrations() {
    const startVersion = this.getCurrentVersion();

    // Build migrations from plugin type schemas
    const migrations = buildMigrations();

    // Apply migrations
    for (const migration of migrations) {
      await this.applyMigration(migration.version, migration.description, migration.fn);
    }

    const endVersion = this.getCurrentVersion();
    if (endVersion > startVersion && this.verbose) {
      console.log(`Database migrated from version ${startVersion} to ${endVersion}`);
    }
  }
}
