// Database migration system for schema versioning
import { getDatabase } from './database-service.js';

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
      
      console.log(`  ✓ Migration ${version} applied successfully`);
      return true;
    } catch (error) {
      console.error(`  ✗ Migration ${version} failed:`, error.message);
      throw error;
    }
  }

  async runMigrations() {
    console.log('Running database migrations...');
    const startVersion = this.getCurrentVersion();
    
    // Define all migrations here
    const migrations = [
      {
        version: 1,
        description: 'Remove redundant task_completions table',
        fn: (db) => {
          // Skip this migration - we're keeping task_completions for now
          // since the restored database has it and uses it
          console.log('    Skipped: keeping task_completions table from restored database');
        }
      },
      {
        version: 2,
        description: 'Add index on tasks.completed_at',
        fn: (db) => {
          // Check if tasks table exists before creating index
          const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
          if (tableExists) {
            // Ensure we have an index on completed_at since we're using it directly now
            db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at)');
            console.log('    Added index on tasks.completed_at');
          } else {
            console.log('    Skipped: tasks table does not exist');
          }
        }
      },
      {
        version: 3,
        description: 'Clean up task_completions references from turso sync',
        fn: (db) => {
          // This is more of a code change marker, but we record it for consistency
          console.log('    Marked: task_completions removed from sync code');
        }
      }
    ];

    // Apply migrations in order
    let appliedCount = 0;
    for (const migration of migrations) {
      if (await this.applyMigration(migration.version, migration.description, migration.fn)) {
        appliedCount++;
      }
    }

    const endVersion = this.getCurrentVersion();
    
    if (appliedCount > 0) {
      console.log(`✅ Applied ${appliedCount} migrations (v${startVersion} → v${endVersion})`);
    } else {
      console.log(`✅ Database is up to date (v${endVersion})`);
    }
    
    return endVersion;
  }
}

// Export function to run migrations on a database
export async function runMigrations(dbPath) {
  const db = getDatabase(dbPath);
  const manager = new MigrationManager(db);
  const version = await manager.runMigrations();
  // Don't close singleton
  return version;
}