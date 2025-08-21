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
      },
      {
        version: 4,
        description: 'Add timestamp columns to tables for efficient sync',
        fn: (db) => {
          // List of tables and which columns they need
          const tablesNeedingTimestamps = [
            { name: 'cache_metadata', needsCreated: true, needsUpdated: true },
            { name: 'contact_addresses', needsCreated: true, needsUpdated: true },
            { name: 'contact_emails', needsCreated: true, needsUpdated: true },
            { name: 'contact_phones', needsCreated: true, needsUpdated: true },
            { name: 'database_cache', needsCreated: true, needsUpdated: true },
            { name: 'email_entity_mentions', needsCreated: false, needsUpdated: true },
            { name: 'emails', needsCreated: true, needsUpdated: true },
            { name: 'event_attendees', needsCreated: false, needsUpdated: true },
            { name: 'markdown_sync', needsCreated: true, needsUpdated: true },
            { name: 'people_to_contact', needsCreated: false, needsUpdated: true },
            { name: 'project_cache', needsCreated: true, needsUpdated: true },
            { name: 'project_pillar_mapping', needsCreated: true, needsUpdated: false },
            { name: 'project_topics', needsCreated: true, needsUpdated: true },
            { name: 'schema_version', needsCreated: true, needsUpdated: true },
            { name: 'status_groups_cache', needsCreated: true, needsUpdated: true },
            { name: 'streaks_data', needsCreated: true, needsUpdated: true },
            { name: 'summary_insights', needsCreated: false, needsUpdated: true },
            { name: 'summary_meta', needsCreated: false, needsUpdated: true },
            { name: 'summary_metrics', needsCreated: false, needsUpdated: true },
            { name: 'summary_recommendations', needsCreated: false, needsUpdated: true },
            { name: 'sync_log', needsCreated: false, needsUpdated: true },
            { name: 'sync_metadata', needsCreated: true, needsUpdated: true },
            { name: 'tag_cache', needsCreated: true, needsUpdated: true },
            { name: 'tags', needsCreated: true, needsUpdated: true },
            { name: 'task_cache', needsCreated: true, needsUpdated: true },
            { name: 'task_event_links', needsCreated: false, needsUpdated: true },
            { name: 'task_projects', needsCreated: true, needsUpdated: true },
            { name: 'task_relationships', needsCreated: false, needsUpdated: true },
            { name: 'task_tags', needsCreated: true, needsUpdated: true },
            { name: 'task_topics', needsCreated: true, needsUpdated: true },
            { name: 'temporal_sync', needsCreated: false, needsUpdated: true },
            { name: 'time_entries_sync', needsCreated: true, needsUpdated: true },
            { name: 'todoist_sync_mapping', needsCreated: true, needsUpdated: true }
          ];
          
          let addedColumns = 0;
          for (const table of tablesNeedingTimestamps) {
            // Check if table exists
            const tableExists = db.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
            ).get(table.name);
            
            if (!tableExists) {
              continue;
            }
            
            // Get current columns
            const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
            const columnNames = columns.map(c => c.name);
            
            // Add created_at if needed
            if (table.needsCreated && !columnNames.includes('created_at')) {
              try {
                db.exec(`ALTER TABLE ${table.name} ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
                console.log(`    Added created_at to ${table.name}`);
                addedColumns++;
              } catch (e) {
                // Column might already exist
              }
            }
            
            // Add updated_at if needed
            if (table.needsUpdated && !columnNames.includes('updated_at')) {
              try {
                db.exec(`ALTER TABLE ${table.name} ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
                console.log(`    Added updated_at to ${table.name}`);
                addedColumns++;
                
                // Create trigger to update the updated_at column automatically
                db.exec(`
                  CREATE TRIGGER IF NOT EXISTS update_${table.name}_updated_at
                  AFTER UPDATE ON ${table.name}
                  FOR EACH ROW
                  BEGIN
                    UPDATE ${table.name} SET updated_at = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid;
                  END
                `);
              } catch (e) {
                // Column might already exist
              }
            }
          }
          
          console.log(`    Added ${addedColumns} timestamp columns`);
        }
      },
      {
        version: 5,
        description: 'Add Toggl time tracking tables',
        fn: (db) => {
          // Create time_entries table for Toggl data
          db.exec(`
            CREATE TABLE IF NOT EXISTS toggl_time_entries (
              id INTEGER PRIMARY KEY,
              description TEXT,
              wid INTEGER,
              pid INTEGER,
              tid INTEGER,
              billable BOOLEAN DEFAULT 0,
              start DATETIME NOT NULL,
              stop DATETIME,
              duration INTEGER,
              created_with TEXT,
              tags TEXT,
              duronly BOOLEAN DEFAULT 0,
              at DATETIME,
              server_deleted_at DATETIME,
              user_id INTEGER,
              uid INTEGER,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
          
          // Create projects table for Toggl projects
          db.exec(`
            CREATE TABLE IF NOT EXISTS toggl_projects (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              wid INTEGER,
              cid INTEGER,
              active BOOLEAN DEFAULT 1,
              is_private BOOLEAN DEFAULT 1,
              template BOOLEAN DEFAULT 0,
              template_id INTEGER,
              billable BOOLEAN DEFAULT 0,
              auto_estimates BOOLEAN DEFAULT 0,
              estimated_hours INTEGER,
              at DATETIME,
              color TEXT,
              rate REAL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
          
          // Create clients table for Toggl clients
          db.exec(`
            CREATE TABLE IF NOT EXISTS toggl_clients (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              wid INTEGER,
              notes TEXT,
              at DATETIME,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
          
          // Create tags table for Toggl tags
          db.exec(`
            CREATE TABLE IF NOT EXISTS toggl_tags (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              wid INTEGER,
              at DATETIME,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
          
          // Create daily summaries view for easy analysis
          db.exec(`
            CREATE VIEW IF NOT EXISTS toggl_daily_summary AS
            SELECT 
              DATE(start) as date,
              SUM(duration) as total_seconds,
              ROUND(SUM(duration) / 3600.0, 2) as total_hours,
              COUNT(*) as entry_count,
              GROUP_CONCAT(tags) as all_tags
            FROM toggl_time_entries
            WHERE stop IS NOT NULL
            GROUP BY DATE(start)
            ORDER BY date DESC
          `);
          
          // Create project summaries view
          db.exec(`
            CREATE VIEW IF NOT EXISTS toggl_project_summary AS
            SELECT 
              p.name as project_name,
              DATE(te.start) as date,
              SUM(te.duration) as total_seconds,
              ROUND(SUM(te.duration) / 3600.0, 2) as total_hours,
              COUNT(*) as entry_count
            FROM toggl_time_entries te
            LEFT JOIN toggl_projects p ON te.pid = p.id
            WHERE te.stop IS NOT NULL
            GROUP BY p.name, DATE(te.start)
            ORDER BY date DESC, total_seconds DESC
          `);
          
          // Add indexes for performance
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_toggl_time_entries_start ON toggl_time_entries(start);
            CREATE INDEX IF NOT EXISTS idx_toggl_time_entries_pid ON toggl_time_entries(pid);
            CREATE INDEX IF NOT EXISTS idx_toggl_time_entries_user ON toggl_time_entries(user_id);
            CREATE INDEX IF NOT EXISTS idx_toggl_projects_wid ON toggl_projects(wid);
          `);
          
          console.log('    Created Toggl tracking tables and views');
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