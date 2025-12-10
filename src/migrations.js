// Database migration system for schema versioning

export class MigrationManager {
  constructor(db) {
    this.db = db;
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
      console.log(`  Migration ${version} already applied: ${description}`);
      return false;
    }

    console.log(`  Applying migration ${version}: ${description}`);

    try {
      // Run migration in a transaction
      this.db.transaction(() => {
        migrationFn(this.db);

        // Record the migration
        this.db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
          .run(version, description);
      })();

      console.log(`  Migration ${version} applied successfully`);
      return true;
    } catch (error) {
      console.error(`  Migration ${version} failed:`, error.message);
      throw error;
    }
  }

  async runMigrations() {
    console.log('Running database migrations...');
    const startVersion = this.getCurrentVersion();

    // Plugin type tables will be added here as we build each one
    const migrations = [];

    // Apply migrations
    for (const migration of migrations) {
      await this.applyMigration(migration.version, migration.description, migration.fn);
    }

    const endVersion = this.getCurrentVersion();
    if (endVersion > startVersion) {
      console.log(`Database migrated from version ${startVersion} to ${endVersion}`);
    } else {
      console.log(`Database at version ${endVersion} (no migrations needed)`);
    }
  }
}
