// Database migration system for schema versioning
import Database from 'better-sqlite3';

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
        description: 'Create base database schema',
        fn: (db) => {
          // Always check if tables exist and create if missing
          // This ensures the schema is created even if migration was previously marked as applied
          const tasksExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
          
          if (!tasksExists) {
            console.log('    Creating database schema...');
            
            // Create all tables directly here instead of loading from file
            db.exec(`
              -- Core task management tables
              CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                title TEXT NOT NULL,
                description TEXT,
                content TEXT,
                do_date DATE,
                status TEXT DEFAULT '🎭 Stage',
                stage TEXT CHECK(stage IS NULL OR stage IN ('Front Stage', 'Back Stage', 'Off Stage')),
                project_id TEXT,
                repeat_interval INTEGER,
                repeat_next_date DATE,
                notion_id TEXT UNIQUE,
                notion_url TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                FOREIGN KEY (project_id) REFERENCES projects(id)
              );
              
              CREATE INDEX IF NOT EXISTS idx_tasks_do_date ON tasks(do_date);
              CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
              CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(stage);
              CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
              CREATE INDEX IF NOT EXISTS idx_tasks_notion_id ON tasks(notion_id);
              
              CREATE TRIGGER IF NOT EXISTS update_task_timestamp
                AFTER UPDATE ON tasks
                BEGIN
                  UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
                END;
              
              -- Projects table
              CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                name TEXT NOT NULL,
                description TEXT,
                status TEXT DEFAULT 'active',
                start_date DATE,
                end_date DATE,
                budget REAL,
                file_path TEXT UNIQUE,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              
              -- Tags table
              CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                name TEXT UNIQUE NOT NULL,
                color TEXT
              );
              
              -- Topics table
              CREATE TABLE IF NOT EXISTS topics (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                name TEXT UNIQUE NOT NULL,
                description TEXT,
                notion_id TEXT UNIQUE,
                color TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_topics_notion ON topics(notion_id);
              
              -- Junction tables for many-to-many relationships
              CREATE TABLE IF NOT EXISTS task_tags (
                task_id TEXT,
                tag_id TEXT,
                PRIMARY KEY (task_id, tag_id),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_task_tags_task ON task_tags(task_id);
              CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);
              
              CREATE TABLE IF NOT EXISTS task_topics (
                task_id TEXT,
                topic_id TEXT,
                PRIMARY KEY (task_id, topic_id),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_task_topics_task ON task_topics(task_id);
              CREATE INDEX IF NOT EXISTS idx_task_topics_topic ON task_topics(topic_id);
              
              CREATE TABLE IF NOT EXISTS task_projects (
                task_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                PRIMARY KEY (task_id, project_id),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_task_projects_task ON task_projects(task_id);
              CREATE INDEX IF NOT EXISTS idx_task_projects_project ON task_projects(project_id);
              
              CREATE TABLE IF NOT EXISTS project_topics (
                project_id TEXT,
                topic_id TEXT,
                PRIMARY KEY (project_id, topic_id),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_project_topics_project ON project_topics(project_id);
              CREATE INDEX IF NOT EXISTS idx_project_topics_topic ON project_topics(topic_id);
              
              -- Task relationships and completions
              CREATE TABLE IF NOT EXISTS task_completions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_completions_task ON task_completions(task_id);
              CREATE INDEX IF NOT EXISTS idx_completions_date ON task_completions(completed_at);
              
              CREATE TABLE IF NOT EXISTS task_relationships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                related_task_id TEXT NOT NULL,
                relationship_type TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_task_relationships_task ON task_relationships(task_id);
              CREATE INDEX IF NOT EXISTS idx_task_relationships_related ON task_relationships(related_task_id);
              CREATE INDEX IF NOT EXISTS idx_task_relationships_type ON task_relationships(relationship_type);
              
              CREATE TABLE IF NOT EXISTS task_event_links (
                task_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                relationship_type TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (task_id, event_id)
              );
              CREATE INDEX IF NOT EXISTS idx_task_event_task ON task_event_links(task_id);
              CREATE INDEX IF NOT EXISTS idx_task_event_event ON task_event_links(event_id);
              
              -- Markdown sync tracking
              CREATE TABLE IF NOT EXISTS markdown_sync (
                file_path TEXT NOT NULL,
                task_id TEXT NOT NULL,
                line_number INTEGER,
                last_synced DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (file_path, task_id),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
              );
              
              -- File tracking
              CREATE TABLE IF NOT EXISTS file_tracking (
                file_path TEXT PRIMARY KEY,
                last_modified DATETIME NOT NULL,
                file_type TEXT,
                category TEXT,
                size_bytes INTEGER,
                hash TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_file_tracking_last_modified ON file_tracking(last_modified);
              CREATE INDEX IF NOT EXISTS idx_file_tracking_category ON file_tracking(category);
              CREATE INDEX IF NOT EXISTS idx_file_tracking_file_type ON file_tracking(file_type);
              
              -- Cache tables
              CREATE TABLE IF NOT EXISTS cache_metadata (
                database_id TEXT PRIMARY KEY,
                cache_type TEXT NOT NULL,
                last_edited_time TEXT NOT NULL,
                cached_at INTEGER NOT NULL
              );
              
              CREATE TABLE IF NOT EXISTS database_cache (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                cached_at INTEGER NOT NULL
              );
              
              CREATE TABLE IF NOT EXISTS task_cache (
                id TEXT PRIMARY KEY,
                database_id TEXT NOT NULL,
                title TEXT NOT NULL,
                properties TEXT NOT NULL,
                url TEXT NOT NULL,
                created_time TEXT NOT NULL,
                last_edited_time TEXT,
                cached_at INTEGER NOT NULL
              );
              
              CREATE TABLE IF NOT EXISTS project_cache (
                id TEXT PRIMARY KEY,
                database_id TEXT NOT NULL,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                created_time TEXT NOT NULL,
                status TEXT,
                cached_at INTEGER NOT NULL
              );
              
              CREATE TABLE IF NOT EXISTS tag_cache (
                id TEXT PRIMARY KEY,
                database_id TEXT NOT NULL,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                created_time TEXT NOT NULL,
                cached_at INTEGER NOT NULL
              );
              
              CREATE TABLE IF NOT EXISTS status_groups_cache (
                database_id TEXT PRIMARY KEY,
                status_groups TEXT NOT NULL,
                last_edited_time TEXT NOT NULL,
                cached_at INTEGER NOT NULL
              );
              
              -- Contact management
              CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                first_name TEXT,
                last_name TEXT,
                full_name TEXT,
                organization TEXT,
                birthday TEXT,
                url TEXT,
                etag TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_contacts_full_name ON contacts(full_name);
              CREATE INDEX IF NOT EXISTS idx_contacts_last_name ON contacts(last_name);
              
              CREATE TABLE IF NOT EXISTS contact_emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contact_id TEXT NOT NULL,
                email TEXT NOT NULL,
                is_primary BOOLEAN DEFAULT 0,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_contact_emails_email ON contact_emails(email);
              CREATE INDEX IF NOT EXISTS idx_contact_emails_contact_id ON contact_emails(contact_id);
              
              CREATE TABLE IF NOT EXISTS contact_phones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contact_id TEXT NOT NULL,
                phone TEXT NOT NULL,
                is_primary BOOLEAN DEFAULT 0,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_contact_phones_contact_id ON contact_phones(contact_id);
              
              CREATE TABLE IF NOT EXISTS contact_addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contact_id TEXT NOT NULL,
                po_box TEXT,
                extended TEXT,
                street TEXT,
                city TEXT,
                region TEXT,
                postal_code TEXT,
                country TEXT,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_contact_addresses_contact_id ON contact_addresses(contact_id);
              
              -- Calendar and events
              CREATE TABLE IF NOT EXISTS calendar_events (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                calendar_name TEXT,
                title TEXT NOT NULL,
                start_date DATETIME NOT NULL,
                end_date DATETIME NOT NULL,
                start_timezone TEXT,
                end_timezone TEXT,
                location TEXT,
                description TEXT,
                all_day BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_calendar_events_start_date ON calendar_events(start_date);
              CREATE INDEX IF NOT EXISTS idx_calendar_events_end_date ON calendar_events(end_date);
              CREATE INDEX IF NOT EXISTS idx_calendar_events_title ON calendar_events(title);
              CREATE INDEX IF NOT EXISTS idx_calendar_events_source ON calendar_events(source);
              
              CREATE TABLE IF NOT EXISTS event_attendees (
                event_id TEXT NOT NULL,
                contact_id TEXT,
                email TEXT NOT NULL,
                name TEXT,
                response_status TEXT,
                is_organizer BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (event_id, email)
              );
              CREATE INDEX IF NOT EXISTS idx_event_attendees_event ON event_attendees(event_id);
              CREATE INDEX IF NOT EXISTS idx_event_attendees_contact ON event_attendees(contact_id);
              CREATE INDEX IF NOT EXISTS idx_event_attendees_email ON event_attendees(email);
              
              -- Email tables
              CREATE TABLE IF NOT EXISTS emails (
                id INTEGER PRIMARY KEY,
                uid INTEGER,
                message_id TEXT,
                from_address TEXT,
                to_address TEXT,
                subject TEXT,
                date DATETIME,
                headers TEXT,
                text_content TEXT,
                html_content TEXT,
                attachments TEXT,
                flags TEXT,
                size INTEGER,
                raw_source TEXT,
                folder TEXT DEFAULT 'INBOX',
                downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              
              CREATE TABLE IF NOT EXISTS email_entity_mentions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                confidence REAL DEFAULT 1.0,
                context TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_email_mentions_email ON email_entity_mentions(email_id);
              CREATE INDEX IF NOT EXISTS idx_email_mentions_entity ON email_entity_mentions(entity_type, entity_id);
              
              -- Summary and analytics tables
              CREATE TABLE IF NOT EXISTS summary_insights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                summary_date DATE NOT NULL,
                category TEXT NOT NULL,
                insight TEXT NOT NULL,
                priority INTEGER DEFAULT 0,
                confidence REAL DEFAULT 0.0,
                related_entity_type TEXT,
                related_entity_id TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_summary_insights_date ON summary_insights(summary_date);
              CREATE INDEX IF NOT EXISTS idx_summary_insights_category ON summary_insights(category);
              CREATE INDEX IF NOT EXISTS idx_summary_insights_priority ON summary_insights(priority);
              
              CREATE TABLE IF NOT EXISTS summary_meta (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                summary_date DATE NOT NULL,
                last_updated DATETIME NOT NULL,
                version TEXT,
                update_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_summary_meta_date ON summary_meta(summary_date);
              
              CREATE TABLE IF NOT EXISTS summary_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                summary_date DATE NOT NULL,
                metric_name TEXT NOT NULL,
                metric_value REAL,
                metric_unit TEXT,
                category TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_summary_metrics_date ON summary_metrics(summary_date);
              CREATE INDEX IF NOT EXISTS idx_summary_metrics_name ON summary_metrics(metric_name);
              
              CREATE TABLE IF NOT EXISTS summary_recommendations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                summary_date DATE NOT NULL,
                recommendation TEXT NOT NULL,
                reason TEXT,
                priority INTEGER DEFAULT 0,
                category TEXT,
                status TEXT DEFAULT 'pending',
                related_task_id TEXT,
                related_contact_id TEXT,
                related_project_id TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_summary_recommendations_date ON summary_recommendations(summary_date);
              CREATE INDEX IF NOT EXISTS idx_summary_recommendations_status ON summary_recommendations(status);
              CREATE INDEX IF NOT EXISTS idx_summary_recommendations_priority ON summary_recommendations(priority);
              
              CREATE TABLE IF NOT EXISTS people_to_contact (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                summary_date DATE NOT NULL,
                contact_id TEXT,
                contact_name TEXT NOT NULL,
                reason TEXT,
                urgency TEXT,
                last_contact_date DATE,
                suggested_action TEXT,
                completed BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_people_to_contact_date ON people_to_contact(summary_date);
              CREATE INDEX IF NOT EXISTS idx_people_to_contact_completed ON people_to_contact(completed);
              CREATE INDEX IF NOT EXISTS idx_people_to_contact_contact_id ON people_to_contact(contact_id);
              
              -- Sync tracking tables
              CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME NOT NULL,
                sync_type TEXT,
                success BOOLEAN DEFAULT 0,
                source_system TEXT,
                target_system TEXT,
                created_count INTEGER DEFAULT 0,
                updated_count INTEGER DEFAULT 0,
                deleted_count INTEGER DEFAULT 0,
                skipped_count INTEGER DEFAULT 0,
                error_count INTEGER DEFAULT 0,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
              CREATE INDEX IF NOT EXISTS idx_sync_log_success ON sync_log(success);
              CREATE INDEX IF NOT EXISTS idx_sync_log_sync_type ON sync_log(sync_type);
              
              CREATE TABLE IF NOT EXISTS sync_metadata (key TEXT PRIMARY KEY, value TEXT);
              
              CREATE TABLE IF NOT EXISTS temporal_sync (
                date TEXT PRIMARY KEY,
                day_id TEXT,
                week_id TEXT,
                created_at INTEGER,
                synced_at INTEGER,
                week_start_date TEXT,
                previous_day_id TEXT
              );
              
              CREATE TABLE IF NOT EXISTS time_entries_sync (
                id TEXT PRIMARY KEY,
                toggl_id TEXT,
                focus_id TEXT,
                processed_at INTEGER,
                pillar_id TEXT,
                duration INTEGER,
                description TEXT,
                project_name TEXT
              );
              
              CREATE TABLE IF NOT EXISTS todoist_sync_mapping (
                notion_id TEXT PRIMARY KEY,
                todoist_id TEXT NOT NULL,
                last_synced INTEGER NOT NULL,
                sync_hash TEXT,
                notion_last_edited TEXT,
                todoist_last_edited TEXT,
                notion_hash TEXT,
                todoist_hash TEXT
              );
              
              -- Streaks and project mapping
              CREATE TABLE IF NOT EXISTS streaks_data (
                id TEXT PRIMARY KEY,
                streak_name TEXT,
                current_count INTEGER,
                last_updated TEXT,
                data_hash TEXT,
                notion_page_id TEXT
              );
              
              CREATE TABLE IF NOT EXISTS project_pillar_mapping (
                toggl_project_id TEXT PRIMARY KEY,
                notion_pillar_id TEXT,
                project_name TEXT,
                pillar_name TEXT,
                updated_at INTEGER
              );
              
              -- Diary table
              CREATE TABLE IF NOT EXISTS diary (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date DATE NOT NULL UNIQUE,
                content TEXT,
                mood TEXT,
                tags TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_diary_date ON diary(date);
              
              -- OGM (OlderGayMen) specific tables
              CREATE TABLE IF NOT EXISTS ogm_correlations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                metric1 TEXT NOT NULL,
                metric2 TEXT NOT NULL,
                correlation REAL,
                p_value REAL,
                sample_size INTEGER,
                period TEXT,
                calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              
              CREATE TABLE IF NOT EXISTS ogm_github_issues (
                id INTEGER PRIMARY KEY,
                number INTEGER NOT NULL,
                title TEXT NOT NULL,
                state TEXT,
                labels TEXT,
                created_at DATETIME,
                updated_at DATETIME,
                closed_at DATETIME,
                body TEXT,
                url TEXT,
                synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_ogm_github_issues_number ON ogm_github_issues(number);
              CREATE INDEX IF NOT EXISTS idx_ogm_github_issues_state ON ogm_github_issues(state);
              
              CREATE TABLE IF NOT EXISTS ogm_honeybadger_faults (
                id INTEGER PRIMARY KEY,
                fault_id INTEGER UNIQUE NOT NULL,
                error_class TEXT,
                error_message TEXT,
                occurrences INTEGER,
                created_at DATETIME,
                last_occurred_at DATETIME,
                resolved BOOLEAN DEFAULT 0,
                environment TEXT,
                synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_ogm_honeybadger_faults_fault_id ON ogm_honeybadger_faults(fault_id);
              CREATE INDEX IF NOT EXISTS idx_ogm_honeybadger_faults_resolved ON ogm_honeybadger_faults(resolved);
              
              CREATE TABLE IF NOT EXISTS ogm_scout_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                metric_name TEXT NOT NULL,
                value REAL,
                unit TEXT,
                timestamp DATETIME NOT NULL,
                endpoint TEXT,
                percentile_95 REAL,
                percentile_99 REAL,
                synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_ogm_scout_metrics_timestamp ON ogm_scout_metrics(timestamp);
              CREATE INDEX IF NOT EXISTS idx_ogm_scout_metrics_metric_name ON ogm_scout_metrics(metric_name);
              
              CREATE TABLE IF NOT EXISTS ogm_summary_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date DATE NOT NULL,
                metric_type TEXT NOT NULL,
                metric_name TEXT NOT NULL,
                value REAL,
                unit TEXT,
                calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(date, metric_type, metric_name)
              );
              CREATE INDEX IF NOT EXISTS idx_ogm_summary_stats_date ON ogm_summary_stats(date);
              CREATE INDEX IF NOT EXISTS idx_ogm_summary_stats_type ON ogm_summary_stats(metric_type);
            `);
            
            console.log('    Created all database tables');
          } else {
            console.log('    Tables already exist, checking for missing tables...');
            // Even if tasks exists, check for other missing tables
            // This handles partial schema scenarios
            
            // List of all expected tables
            const expectedTables = [
              'tasks', 'projects', 'tags', 'topics', 'task_tags', 'task_topics', 'task_projects',
              'project_topics', 'task_completions', 'task_relationships', 'task_event_links',
              'markdown_sync', 'file_tracking', 'cache_metadata', 'database_cache', 'task_cache',
              'project_cache', 'tag_cache', 'status_groups_cache', 'contacts', 'contact_emails',
              'contact_phones', 'contact_addresses', 'calendar_events', 'event_attendees',
              'emails', 'email_entity_mentions', 'summary_insights', 'summary_meta',
              'summary_metrics', 'summary_recommendations', 'people_to_contact', 'sync_log',
              'sync_metadata', 'temporal_sync', 'time_entries_sync', 'todoist_sync_mapping',
              'streaks_data', 'project_pillar_mapping', 'diary', 'ogm_correlations',
              'ogm_github_issues', 'ogm_honeybadger_faults', 'ogm_scout_metrics', 'ogm_summary_stats'
            ];
            
            // Check which tables are missing
            const existingTables = db.prepare(
              "SELECT name FROM sqlite_master WHERE type='table'"
            ).all().map(row => row.name);
            
            const missingTables = expectedTables.filter(table => !existingTables.includes(table));
            
            if (missingTables.length > 0) {
              console.log(`    Found ${missingTables.length} missing tables: ${missingTables.join(', ')}`);
              console.log('    Run migrations.js again after deleting .data directory to create all tables');
            }
          }
        }
      },
      {
        version: 2,
        description: 'Ensure index exists on tasks.completed_at',
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
      },
      {
        version: 6,
        description: 'Add last_modified column to tasks table for proper sync tracking',
        fn: (db) => {
          // Check if tasks table exists first
          const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
          
          if (!tableExists) {
            console.log('    Skipped: tasks table does not exist');
            return;
          }
          
          // Check if column already exists
          const columns = db.prepare('PRAGMA table_info(tasks)').all();
          const hasLastModified = columns.some(c => c.name === 'last_modified');
          
          if (!hasLastModified) {
            // Add last_modified column
            db.exec('ALTER TABLE tasks ADD COLUMN last_modified DATETIME');
            
            // Set initial values to current time
            db.exec("UPDATE tasks SET last_modified = datetime('now', 'localtime') WHERE last_modified IS NULL");
            
            // Create trigger to auto-update on changes
            db.exec(`
              CREATE TRIGGER IF NOT EXISTS update_task_last_modified 
              AFTER UPDATE ON tasks 
              FOR EACH ROW
              WHEN NEW.last_modified = OLD.last_modified OR NEW.last_modified IS NULL
              BEGIN
                UPDATE tasks SET last_modified = datetime('now', 'localtime') WHERE id = NEW.id;
              END
            `);
            
            // Add index for performance
            db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_last_modified ON tasks(last_modified)');
            
            console.log('    Added last_modified column to tasks table with auto-update trigger');
          } else {
            console.log('    last_modified column already exists');
          }
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
export async function runMigrations(dbPath = '.data/today.db') {
  const db = new Database(dbPath);
  const manager = new MigrationManager(db);
  const version = await manager.runMigrations();
  db.close();
  return version;
}

// Allow running directly from command line
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().then(() => {
    console.log('Migrations complete');
    process.exit(0);
  }).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}