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
  },
  {
    version: 101,
    description: 'Add extra_data column to sync_metadata for incremental sync state',
    fn: (db) => {
      db.exec(`ALTER TABLE sync_metadata ADD COLUMN extra_data TEXT`);
    }
  },
  {
    version: 102,
    description: 'Drop legacy unused tables',
    fn: (db) => {
      const legacyTables = [
        'cache_metadata',
        'database_cache',
        'project_cache',
        'project_pillar_mapping',
        'status_groups_cache',
        'streaks_data',
        'tag_cache',
        'temporal_sync',
        'time_entries_sync'
      ];
      for (const table of legacyTables) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
    }
  },
  {
    version: 103,
    description: 'Create vault_files table for content-aware change tracking',
    fn: (db) => {
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
      db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_files_source ON vault_files(source)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_files_path ON vault_files(path)`);
    }
  },
  {
    version: 104,
    description: 'Add sync lock columns to sync_metadata for per-source sync locking',
    fn: (db) => {
      db.exec(`ALTER TABLE sync_metadata ADD COLUMN sync_locked_at DATETIME`);
      db.exec(`ALTER TABLE sync_metadata ADD COLUMN sync_locked_by TEXT`);
    }
  },
  {
    version: 105,
    description: 'Create context_cache table for caching gathered AI context',
    fn: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS context_cache (
          cache_key TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
  },
  {
    version: 106,
    description: 'Add scheduled column to financial_transactions',
    fn: (db) => {
      // financial_transactions is built from plugin-schemas.js, so a database
      // created after the field was added already has this column and a bare
      // ALTER would fail with "duplicate column name". The unguarded ALTERs at
      // 101 and 104 are safe only because sync_metadata is created without them.
      const hasColumn = db.prepare(`PRAGMA table_info(financial_transactions)`)
        .all()
        .some(col => col.name === 'scheduled');
      if (!hasColumn) {
        db.exec(`ALTER TABLE financial_transactions ADD COLUMN scheduled INTEGER DEFAULT 0`);
      }
    }
  },
  {
    version: 108,
    description: 'Add transfer column to financial_transactions',
    fn: (db) => {
      // Guarded like 106/107: the table is built from plugin-schemas.js, so a
      // fresh database already has the column.
      const existing = new Set(
        db.prepare(`PRAGMA table_info(financial_transactions)`).all().map(c => c.name)
      );
      if (!existing.has('transfer')) {
        db.exec(`ALTER TABLE financial_transactions ADD COLUMN transfer INTEGER DEFAULT 0`);
      }
      // Backfill from what each plugin already recorded, so existing rows are
      // correct without waiting for a re-sync: the API plugin stores
      // transfer_account_id in metadata, the CSV export uses a payee convention.
      db.exec(`
        UPDATE financial_transactions
        SET transfer = 1
        WHERE IFNULL(transfer, 0) = 0
          AND (json_extract(metadata, '$.transfer_account_id') IS NOT NULL
               OR payee LIKE 'Transfer :%')
      `);
    }
  },
  {
    version: 107,
    description: 'Add dedup_key and superseded_by to financial_transactions for cross-source reconciliation',
    fn: (db) => {
      // Guarded for the same reason as 106: the table is built from
      // plugin-schemas.js, so a fresh database already has these columns.
      const existing = new Set(
        db.prepare(`PRAGMA table_info(financial_transactions)`).all().map(c => c.name)
      );
      if (!existing.has('dedup_key')) {
        db.exec(`ALTER TABLE financial_transactions ADD COLUMN dedup_key TEXT`);
      }
      if (!existing.has('superseded_by')) {
        db.exec(`ALTER TABLE financial_transactions ADD COLUMN superseded_by TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_financial_transactions_dedup_key
               ON financial_transactions(dedup_key)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_financial_transactions_superseded_by
               ON financial_transactions(superseded_by)`);
    }
  }
];

/**
 * Build migrations from plugin type schemas
 * Each schema becomes a numbered migration in order of definition
 * Plugin types without tables (like 'context') are skipped
 */
function buildMigrations() {
  const pluginMigrations = Object.keys(schemas)
    .filter(type => getTableName(type) !== null) // Skip types without tables
    .map((type, index) => {
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

  isMigrationApplied(version) {
    const result = this.db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version);
    return !!result;
  }

  async applyMigration(version, description, migrationFn) {
    // Check if this specific version has been applied (not just max version)
    if (this.isMigrationApplied(version)) {
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
