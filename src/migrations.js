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
                status TEXT DEFAULT '🗂️ To File',
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
              
              CREATE TABLE IF NOT EXISTS ogm_sentry_issues (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                culprit TEXT,
                level TEXT,
                status TEXT,
                count INTEGER DEFAULT 0,
                user_count INTEGER DEFAULT 0,
                first_seen DATETIME NOT NULL,
                last_seen DATETIME,
                synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              CREATE INDEX IF NOT EXISTS idx_ogm_sentry_issues_status ON ogm_sentry_issues(status);
              CREATE INDEX IF NOT EXISTS idx_ogm_sentry_issues_last_seen ON ogm_sentry_issues(last_seen);
              
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
              'ogm_github_issues', 'ogm_sentry_issues', 'ogm_scout_metrics', 'ogm_summary_stats'
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
        description: 'DEPRECATED: Toggl time tracking (replaced with markdown-based tracking)',
        fn: (db) => {
          // Toggl integration has been removed in favor of bin/track markdown-based time tracking
          // This migration is kept for version continuity but does nothing
          console.log('    Skipped: Toggl integration deprecated (use bin/track instead)');
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
      },
      {
        version: 7,
        description: 'Add notes column to contacts table',
        fn: (db) => {
          // Check if contacts table exists first
          const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'").get();
          
          if (!tableExists) {
            console.log('    Skipped: contacts table does not exist');
            return;
          }
          
          // Check if column already exists
          const columns = db.prepare('PRAGMA table_info(contacts)').all();
          const hasNotes = columns.some(c => c.name === 'notes');
          
          if (!hasNotes) {
            // Add notes column
            db.exec('ALTER TABLE contacts ADD COLUMN notes TEXT');
            console.log('    Added notes column to contacts table');
          } else {
            console.log('    notes column already exists in contacts table');
          }
        }
      },
      {
        version: 8,
        description: 'Fix diary table schema for Day One sync',
        fn: (db) => {
          // Drop the old diary table and recreate with correct schema for Day One
          console.log('    Recreating diary table with Day One schema...');
          
          db.exec(`
            DROP TABLE IF EXISTS diary;
            
            CREATE TABLE diary (
              id TEXT PRIMARY KEY,
              creation_date TEXT NOT NULL,
              modified_date TEXT,
              text TEXT NOT NULL,
              starred INTEGER DEFAULT 0,
              location_name TEXT,
              location_latitude REAL,
              location_longitude REAL,
              weather_temp_celsius REAL,
              weather_conditions TEXT,
              tags TEXT,
              journal_file_modified TEXT,
              UNIQUE(id)
            );
            
            CREATE INDEX IF NOT EXISTS idx_diary_creation_date ON diary(creation_date);
            CREATE INDEX IF NOT EXISTS idx_diary_starred ON diary(starred);
            CREATE INDEX IF NOT EXISTS idx_diary_location ON diary(location_name);
          `);
          
          console.log('    Created diary table with Day One schema');
        }
      },
      {
        version: 9,
        description: 'Add missing columns to OGM monitoring tables',
        fn: (db) => {
          // Check and add missing columns to OGM tables
          
          // Add last_seen to ogm_sentry_issues if missing
          const sentryColumns = db.prepare('PRAGMA table_info(ogm_sentry_issues)').all();
          const hasLastSeen = sentryColumns.some(c => c.name === 'last_seen');
          if (!hasLastSeen && sentryColumns.length > 0) {
            db.exec('ALTER TABLE ogm_sentry_issues ADD COLUMN last_seen DATETIME');
            console.log('    Added last_seen to ogm_sentry_issues');
          }
          
          // Add metric_type to ogm_scout_metrics if missing
          const metricsColumns = db.prepare('PRAGMA table_info(ogm_scout_metrics)').all();
          const hasMetricType = metricsColumns.some(c => c.name === 'metric_type');
          if (!hasMetricType && metricsColumns.length > 0) {
            db.exec('ALTER TABLE ogm_scout_metrics ADD COLUMN metric_type TEXT');
            console.log('    Added metric_type to ogm_scout_metrics');
          }
          
          // Add stat_date to ogm_summary_stats if missing
          const statsColumns = db.prepare('PRAGMA table_info(ogm_summary_stats)').all();
          const hasStatDate = statsColumns.some(c => c.name === 'stat_date');
          if (!hasStatDate && statsColumns.length > 0) {
            db.exec('ALTER TABLE ogm_summary_stats ADD COLUMN stat_date DATE');
            console.log('    Added stat_date to ogm_summary_stats');
          }
          
          console.log('    Fixed OGM monitoring table schemas');
        }
      },
      {
        version: 10,
        description: 'Add remaining OGM table columns for complete sync',
        fn: (db) => {
          // Add missing columns to ogm_github_issues
          const issuesColumns = db.prepare('PRAGMA table_info(ogm_github_issues)').all();
          const issueColumnNames = issuesColumns.map(c => c.name);
          
          if (issuesColumns.length > 0) {
            if (!issueColumnNames.includes('comments_count')) {
              db.exec('ALTER TABLE ogm_github_issues ADD COLUMN comments_count INTEGER DEFAULT 0');
              console.log('    Added comments_count to ogm_github_issues');
            }
            if (!issueColumnNames.includes('assignee')) {
              db.exec('ALTER TABLE ogm_github_issues ADD COLUMN assignee TEXT');
              console.log('    Added assignee to ogm_github_issues');
            }
            if (!issueColumnNames.includes('milestone')) {
              db.exec('ALTER TABLE ogm_github_issues ADD COLUMN milestone TEXT');
              console.log('    Added milestone to ogm_github_issues');
            }
            if (!issueColumnNames.includes('user')) {
              db.exec('ALTER TABLE ogm_github_issues ADD COLUMN user TEXT');
              console.log('    Added user to ogm_github_issues');
            }
          }
          
          // Add missing columns to ogm_sentry_issues
          const sentryColumns = db.prepare('PRAGMA table_info(ogm_sentry_issues)').all();
          const sentryColumnNames = sentryColumns.map(c => c.name);
          
          if (sentryColumns.length > 0) {
            if (!sentryColumnNames.includes('count')) {
              db.exec('ALTER TABLE ogm_sentry_issues ADD COLUMN count INTEGER DEFAULT 0');
              console.log('    Added count to ogm_sentry_issues');
            }
            if (!sentryColumnNames.includes('user_count')) {
              db.exec('ALTER TABLE ogm_sentry_issues ADD COLUMN user_count INTEGER DEFAULT 0');
              console.log('    Added user_count to ogm_sentry_issues');
            }
            if (!sentryColumnNames.includes('metadata')) {
              db.exec('ALTER TABLE ogm_sentry_issues ADD COLUMN metadata TEXT');
              console.log('    Added metadata to ogm_sentry_issues');
            }
            if (!sentryColumnNames.includes('tags')) {
              db.exec('ALTER TABLE ogm_sentry_issues ADD COLUMN tags TEXT');
              console.log('    Added tags to ogm_sentry_issues');
            }
          }
          
          // Add missing columns to ogm_scout_metrics
          const metricsColumns = db.prepare('PRAGMA table_info(ogm_scout_metrics)').all();
          const metricColumnNames = metricsColumns.map(c => c.name);
          
          if (metricsColumns.length > 0) {
            if (!metricColumnNames.includes('controller')) {
              db.exec('ALTER TABLE ogm_scout_metrics ADD COLUMN controller TEXT');
              console.log('    Added controller to ogm_scout_metrics');
            }
            if (!metricColumnNames.includes('action')) {
              db.exec('ALTER TABLE ogm_scout_metrics ADD COLUMN action TEXT');
              console.log('    Added action to ogm_scout_metrics');
            }
            if (!metricColumnNames.includes('count')) {
              db.exec('ALTER TABLE ogm_scout_metrics ADD COLUMN count INTEGER');
              console.log('    Added count to ogm_scout_metrics');
            }
            if (!metricColumnNames.includes('percentile_50')) {
              db.exec('ALTER TABLE ogm_scout_metrics ADD COLUMN percentile_50 REAL');
              console.log('    Added percentile_50 to ogm_scout_metrics');
            }
          }
          
          console.log('    Completed OGM table schema updates');
        }
      },
      {
        version: 11,
        description: 'Consolidate task statuses and set To File as default',
        fn: (db) => {
          console.log('    Consolidating task statuses...');
          
          // First, migrate all '🎭 Stage' tasks to '🗂️ To File'
          const stageResult = db.prepare("UPDATE tasks SET status = '🗂️ To File' WHERE status = '🎭 Stage'").run();
          console.log(`    Migrated ${stageResult.changes} tasks from '🎭 Stage' to '🗂️ To File'`);
          
          // Migrate other statuses that are being removed
          const statusMigrations = [
            { from: '🔥 Immediate', to: '🚀 1st Priority' },
            { from: '📅 Scheduled', to: '🗂️ To File' },
            { from: '💭 Remember', to: '🗂️ To File' },
            { from: '⚡ Quick', to: '🗂️ To File' },
            { from: '🚘 Errand', to: '🗂️ To File' },
            { from: 'Ron', to: '🗂️ To File' },
            { from: 'Freefolk', to: '🗂️ To File' },
            { from: 'Active', to: '🗂️ To File' },
            { from: '♻️ Repeating', to: '🗂️ To File' },
            { from: '🚢 On the trip', to: '🗂️ To File' },
            { from: '🏠 After the trip', to: '🗂️ To File' },
            { from: 'In progress', to: '🗂️ To File' },
            { from: 'Next Up', to: '🗂️ To File' },
            { from: 'Future 1', to: '🗂️ To File' },
            { from: 'Future 2', to: '🗂️ To File' },
            { from: 'Future 3', to: '🗂️ To File' }
          ];
          
          for (const migration of statusMigrations) {
            const result = db.prepare("UPDATE tasks SET status = ? WHERE status = ?").run(migration.to, migration.from);
            if (result.changes > 0) {
              console.log(`    Migrated ${result.changes} tasks from '${migration.from}' to '${migration.to}'`);
            }
          }
          
          // Update the default in the table schema
          // SQLite doesn't support ALTER COLUMN directly, so we need to recreate the table
          console.log('    Updating default status in tasks table schema...');
          
          db.exec(`
            -- Create new table with updated default
            CREATE TABLE tasks_new (
              id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
              title TEXT NOT NULL,
              description TEXT,
              content TEXT,
              do_date DATE,
              status TEXT DEFAULT '🗂️ To File',
              stage TEXT CHECK(stage IS NULL OR stage IN ('Front Stage', 'Back Stage', 'Off Stage')),
              project_id TEXT,
              repeat_interval INTEGER,
              repeat_next_date DATE,
              notion_id TEXT UNIQUE,
              notion_url TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              completed_at DATETIME,
              last_modified DATETIME,
              FOREIGN KEY (project_id) REFERENCES projects(id)
            );
            
            -- Copy data
            INSERT INTO tasks_new SELECT * FROM tasks;
            
            -- Drop old table
            DROP TABLE tasks;
            
            -- Rename new table
            ALTER TABLE tasks_new RENAME TO tasks;
            
            -- Recreate indexes
            CREATE INDEX idx_tasks_do_date ON tasks(do_date);
            CREATE INDEX idx_tasks_status ON tasks(status);
            CREATE INDEX idx_tasks_stage ON tasks(stage);
            CREATE INDEX idx_tasks_project ON tasks(project_id);
            CREATE INDEX idx_tasks_notion_id ON tasks(notion_id);
            CREATE INDEX idx_tasks_completed_at ON tasks(completed_at);
            CREATE INDEX idx_tasks_last_modified ON tasks(last_modified);
            
            -- Recreate triggers
            CREATE TRIGGER update_task_timestamp
              AFTER UPDATE ON tasks
              BEGIN
                UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
              END;
              
            CREATE TRIGGER update_task_last_modified 
              AFTER UPDATE ON tasks 
              FOR EACH ROW
              WHEN NEW.last_modified = OLD.last_modified OR NEW.last_modified IS NULL
              BEGIN
                UPDATE tasks SET last_modified = datetime('now', 'localtime') WHERE id = NEW.id;
              END;
          `);
          
          console.log('    Updated default status to 🗂️ To File');
          
          // Update status_groups_cache to reflect new structure
          const statusGroups = {
            completeStatuses: ["✅ Done"],
            allGroups: [
              {
                name: "To-do",
                color: "gray",
                statuses: ["🗂️ To File", "🚀 1st Priority", "2nd Priority", "3rd Priority", "4th Priority", "5th Priority"]
              },
              {
                name: "In progress",
                color: "blue",
                statuses: ["Waiting", "Paused"]
              },
              {
                name: "Complete",
                color: "green",
                statuses: ["✅ Done"]
              }
            ],
            options: [
              {id: "Y@is", name: "🗂️ To File", color: "orange", description: null},
              {id: "NEU`", name: "🚀 1st Priority", color: "orange", description: null},
              {id: "|^g]", name: "2nd Priority", color: "blue", description: null},
              {id: "A=xG", name: "3rd Priority", color: "purple", description: null},
              {id: "{iZK", name: "4th Priority", color: "default", description: null},
              {id: "I;iQ", name: "5th Priority", color: "default", description: null},
              {id: "baef7a23-0323-4593-9bcd-71f7c9bf13a7", name: "Waiting", color: "red", description: null},
              {id: "e39cf1f3-937f-4836-b1e4-36bab92ee845", name: "Paused", color: "yellow", description: null},
              {id: "c7ecae0d-7571-4b0f-b639-d12b21f8792a", name: "✅ Done", color: "green", description: null}
            ]
          };
          
          // Update the status_groups_cache
          db.prepare("UPDATE status_groups_cache SET status_groups = ? WHERE database_id = ?").run(
            JSON.stringify(statusGroups),
            'de1740b0-2421-43a1-8bda-f177cec69e11'
          );
          
          console.log('    Updated status_groups_cache with consolidated statuses');
        }
      },
      {
        version: 12,
        description: 'Remove Next Up status',
        fn: (db) => {
          console.log('    Removing Next Up status...');
          
          // Migrate all 'Next Up' tasks to '🗂️ To File'
          const result = db.prepare("UPDATE tasks SET status = '🗂️ To File' WHERE status = 'Next Up'").run();
          console.log(`    Migrated ${result.changes} tasks from 'Next Up' to '🗂️ To File'`);
          
          // Update status_groups_cache to remove Next Up
          const statusGroups = {
            completeStatuses: ["✅ Done"],
            allGroups: [
              {
                name: "To-do",
                color: "gray",
                statuses: ["🗂️ To File", "🚀 1st Priority", "2nd Priority", "3rd Priority", "4th Priority", "5th Priority"]
              },
              {
                name: "In progress",
                color: "blue",
                statuses: ["Waiting", "Paused"]
              },
              {
                name: "Complete",
                color: "green",
                statuses: ["✅ Done"]
              }
            ],
            options: [
              {id: "Y@is", name: "🗂️ To File", color: "orange", description: null},
              {id: "NEU`", name: "🚀 1st Priority", color: "orange", description: null},
              {id: "|^g]", name: "2nd Priority", color: "blue", description: null},
              {id: "A=xG", name: "3rd Priority", color: "purple", description: null},
              {id: "{iZK", name: "4th Priority", color: "default", description: null},
              {id: "I;iQ", name: "5th Priority", color: "default", description: null},
              {id: "baef7a23-0323-4593-9bcd-71f7c9bf13a7", name: "Waiting", color: "red", description: null},
              {id: "e39cf1f3-937f-4836-b1e4-36bab92ee845", name: "Paused", color: "yellow", description: null},
              {id: "c7ecae0d-7571-4b0f-b639-d12b21f8792a", name: "✅ Done", color: "green", description: null}
            ]
          };
          
          // Update the status_groups_cache
          db.prepare("UPDATE status_groups_cache SET status_groups = ? WHERE database_id = ?").run(
            JSON.stringify(statusGroups),
            'de1740b0-2421-43a1-8bda-f177cec69e11'
          );
          
          console.log('    Updated status_groups_cache to remove Next Up');
        }
      },
      {
        version: 13,
        description: 'Add emojis to priority statuses',
        fn: (db) => {
          console.log('    Adding emojis to priority statuses...');
          
          // Update tasks with new status names
          const statusUpdates = [
            { from: '2nd Priority', to: '🎯 2nd Priority' },
            { from: '3rd Priority', to: '📌 3rd Priority' },
            { from: '4th Priority', to: '🔄 4th Priority' },
            { from: '5th Priority', to: '💡 5th Priority' },
            { from: 'Waiting', to: '⏸️ Waiting' },
            { from: 'Paused', to: '⏯️ Paused' }
          ];
          
          for (const update of statusUpdates) {
            const result = db.prepare("UPDATE tasks SET status = ? WHERE status = ?").run(update.to, update.from);
            if (result.changes > 0) {
              console.log(`    Updated ${result.changes} tasks from '${update.from}' to '${update.to}'`);
            }
          }
          
          // Update status_groups_cache with new names
          const statusGroups = {
            completeStatuses: ["✅ Done"],
            allGroups: [
              {
                name: "To-do",
                color: "gray",
                statuses: ["🗂️ To File", "🚀 1st Priority", "🎯 2nd Priority", "📌 3rd Priority", "🔄 4th Priority", "💡 5th Priority"]
              },
              {
                name: "In progress",
                color: "blue",
                statuses: ["⏸️ Waiting", "⏯️ Paused"]
              },
              {
                name: "Complete",
                color: "green",
                statuses: ["✅ Done"]
              }
            ],
            options: [
              {id: "Y@is", name: "🗂️ To File", color: "orange", description: null},
              {id: "NEU`", name: "🚀 1st Priority", color: "orange", description: null},
              {id: "|^g]", name: "🎯 2nd Priority", color: "blue", description: null},
              {id: "A=xG", name: "📌 3rd Priority", color: "purple", description: null},
              {id: "{iZK", name: "🔄 4th Priority", color: "default", description: null},
              {id: "I;iQ", name: "💡 5th Priority", color: "default", description: null},
              {id: "baef7a23-0323-4593-9bcd-71f7c9bf13a7", name: "⏸️ Waiting", color: "red", description: null},
              {id: "e39cf1f3-937f-4836-b1e4-36bab92ee845", name: "⏯️ Paused", color: "yellow", description: null},
              {id: "c7ecae0d-7571-4b0f-b639-d12b21f8792a", name: "✅ Done", color: "green", description: null}
            ]
          };
          
          // Update the status_groups_cache
          db.prepare("UPDATE status_groups_cache SET status_groups = ? WHERE database_id = ?").run(
            JSON.stringify(statusGroups),
            'de1740b0-2421-43a1-8bda-f177cec69e11'
          );
          
          console.log('    Added emojis to all priority statuses');
        }
      },
      {
        version: 14,
        description: 'Refine statuses: remove 4th/5th priorities, update emojis',
        fn: (db) => {
          console.log('    Refining task statuses...');
          
          // Update existing statuses with new names
          const statusUpdates = [
            // Remove 4th and 5th priorities by moving to To File
            { from: '🔄 4th Priority', to: '🗂️ To File' },
            { from: '💡 5th Priority', to: '🗂️ To File' },
            { from: '4th Priority', to: '🗂️ To File' },
            { from: '5th Priority', to: '🗂️ To File' },
            // Update priority emojis to numbers
            { from: '🚀 1st Priority', to: '1️⃣ Priority' },
            { from: '🎯 2nd Priority', to: '2️⃣ Priority' },
            { from: '📌 3rd Priority', to: '3️⃣ Priority' },
            { from: '1st Priority', to: '1️⃣ Priority' },
            { from: '2nd Priority', to: '2️⃣ Priority' },
            { from: '3rd Priority', to: '3️⃣ Priority' },
            // Update waiting and paused emojis
            { from: '⏸️ Waiting', to: '🤔 Waiting' },
            { from: '⏯️ Paused', to: '⏸️ Paused' },
            { from: 'Waiting', to: '🤔 Waiting' },
            { from: 'Paused', to: '⏸️ Paused' }
          ];
          
          for (const update of statusUpdates) {
            const result = db.prepare("UPDATE tasks SET status = ? WHERE status = ?").run(update.to, update.from);
            if (result.changes > 0) {
              console.log(`    Updated ${result.changes} tasks from '${update.from}' to '${update.to}'`);
            }
          }
          
          // Update status_groups_cache with refined structure
          const statusGroups = {
            completeStatuses: ["✅ Done"],
            allGroups: [
              {
                name: "To-do",
                color: "gray",
                statuses: ["🗂️ To File", "1️⃣ Priority", "2️⃣ Priority", "3️⃣ Priority"]
              },
              {
                name: "In progress",
                color: "blue",
                statuses: ["🤔 Waiting", "⏸️ Paused"]
              },
              {
                name: "Complete",
                color: "green",
                statuses: ["✅ Done"]
              }
            ],
            options: [
              {id: "Y@is", name: "🗂️ To File", color: "orange", description: null},
              {id: "NEU`", name: "1️⃣ Priority", color: "red", description: null},
              {id: "|^g]", name: "2️⃣ Priority", color: "orange", description: null},
              {id: "A=xG", name: "3️⃣ Priority", color: "yellow", description: null},
              {id: "baef7a23-0323-4593-9bcd-71f7c9bf13a7", name: "🤔 Waiting", color: "purple", description: null},
              {id: "e39cf1f3-937f-4836-b1e4-36bab92ee845", name: "⏸️ Paused", color: "gray", description: null},
              {id: "c7ecae0d-7571-4b0f-b639-d12b21f8792a", name: "✅ Done", color: "green", description: null}
            ]
          };
          
          // Update the status_groups_cache
          db.prepare("UPDATE status_groups_cache SET status_groups = ? WHERE database_id = ?").run(
            JSON.stringify(statusGroups),
            'de1740b0-2421-43a1-8bda-f177cec69e11'
          );
          
          console.log('    Refined statuses: removed 4th/5th priorities, updated emojis');
        }
      },
      {
        version: 15,
        description: 'Fix status names: keep original names, ensure spaces after emojis',
        fn: (db) => {
          console.log('    Fixing status names with proper spacing...');
          
          // Update statuses to correct format
          const statusUpdates = [
            { from: '1️⃣ Priority', to: '1️⃣ 1st Priority' },
            { from: '2️⃣ Priority', to: '2️⃣ 2nd Priority' },
            { from: '3️⃣ Priority', to: '3️⃣ 3rd Priority' },
            { from: '🤔 Waiting', to: '🤔 Waiting' },  // Already has space
            { from: '⏸️ Paused', to: '⏸️ Paused' },  // Already has space
            { from: '🗂️ To File', to: '🗂️ To File' },  // Already has space
            { from: '✅ Done', to: '✅ Done' }  // Already has space
          ];
          
          for (const update of statusUpdates) {
            if (update.from !== update.to) {
              const result = db.prepare("UPDATE tasks SET status = ? WHERE status = ?").run(update.to, update.from);
              if (result.changes > 0) {
                console.log(`    Updated ${result.changes} tasks from '${update.from}' to '${update.to}'`);
              }
            }
          }
          
          // Update status_groups_cache with correct names
          const statusGroups = {
            completeStatuses: ["✅ Done"],
            allGroups: [
              {
                name: "To-do",
                color: "gray",
                statuses: ["🗂️ To File", "1️⃣ 1st Priority", "2️⃣ 2nd Priority", "3️⃣ 3rd Priority"]
              },
              {
                name: "In progress",
                color: "blue",
                statuses: ["🤔 Waiting", "⏸️ Paused"]
              },
              {
                name: "Complete",
                color: "green",
                statuses: ["✅ Done"]
              }
            ],
            options: [
              {id: "Y@is", name: "🗂️ To File", color: "orange", description: null},
              {id: "NEU`", name: "1️⃣ 1st Priority", color: "red", description: null},
              {id: "|^g]", name: "2️⃣ 2nd Priority", color: "orange", description: null},
              {id: "A=xG", name: "3️⃣ 3rd Priority", color: "yellow", description: null},
              {id: "baef7a23-0323-4593-9bcd-71f7c9bf13a7", name: "🤔 Waiting", color: "purple", description: null},
              {id: "e39cf1f3-937f-4836-b1e4-36bab92ee845", name: "⏸️ Paused", color: "gray", description: null},
              {id: "c7ecae0d-7571-4b0f-b639-d12b21f8792a", name: "✅ Done", color: "green", description: null}
            ]
          };
          
          // Update the status_groups_cache
          db.prepare("UPDATE status_groups_cache SET status_groups = ? WHERE database_id = ?").run(
            JSON.stringify(statusGroups),
            'de1740b0-2421-43a1-8bda-f177cec69e11'
          );
          
          console.log('    Fixed status names with proper emoji spacing');
        }
      },
      {
        version: 16,
        description: 'Ensure proper spacing after all emojis',
        fn: (db) => {
          console.log('    Ensuring proper spacing after all emojis...');
          
          // Update statuses to ensure spacing
          const statusUpdates = [
            { from: '1️⃣ 1st Priority', to: '1️⃣  1st Priority' },  // Add extra space
            { from: '2️⃣ 2nd Priority', to: '2️⃣  2nd Priority' },  // Add extra space
            { from: '3️⃣ 3rd Priority', to: '3️⃣  3rd Priority' },  // Add extra space
            { from: '⏸️ Paused', to: '⏸️  Paused' },  // Add extra space
            { from: '🤔 Waiting', to: '🤔  Waiting' },  // Add extra space
            { from: '🗂️ To File', to: '🗂️  To File' },  // Add extra space
            { from: '✅ Done', to: '✅  Done' }  // Add extra space
          ];
          
          for (const update of statusUpdates) {
            const result = db.prepare("UPDATE tasks SET status = ? WHERE status = ?").run(update.to, update.from);
            if (result.changes > 0) {
              console.log(`    Updated ${result.changes} tasks from '${update.from}' to '${update.to}'`);
            }
          }
          
          // Update status_groups_cache with double spaces for better visual separation
          const statusGroups = {
            completeStatuses: ["✅  Done"],
            allGroups: [
              {
                name: "To-do",
                color: "gray",
                statuses: ["🗂️  To File", "1️⃣  1st Priority", "2️⃣  2nd Priority", "3️⃣  3rd Priority"]
              },
              {
                name: "In progress",
                color: "blue",
                statuses: ["🤔  Waiting", "⏸️  Paused"]
              },
              {
                name: "Complete",
                color: "green",
                statuses: ["✅  Done"]
              }
            ],
            options: [
              {id: "Y@is", name: "🗂️  To File", color: "orange", description: null},
              {id: "NEU`", name: "1️⃣  1st Priority", color: "red", description: null},
              {id: "|^g]", name: "2️⃣  2nd Priority", color: "orange", description: null},
              {id: "A=xG", name: "3️⃣  3rd Priority", color: "yellow", description: null},
              {id: "baef7a23-0323-4593-9bcd-71f7c9bf13a7", name: "🤔  Waiting", color: "purple", description: null},
              {id: "e39cf1f3-937f-4836-b1e4-36bab92ee845", name: "⏸️  Paused", color: "gray", description: null},
              {id: "c7ecae0d-7571-4b0f-b639-d12b21f8792a", name: "✅  Done", color: "green", description: null}
            ]
          };
          
          // Update the status_groups_cache
          db.prepare("UPDATE status_groups_cache SET status_groups = ? WHERE database_id = ?").run(
            JSON.stringify(statusGroups),
            'de1740b0-2421-43a1-8bda-f177cec69e11'
          );
          
          console.log('    Added double spacing after emojis for better visibility');
        }
      },
      {
        version: 17,
        description: 'Fix spacing: single space for Waiting and Done for compatibility',
        fn: (db) => {
          console.log('    Fixing spacing for Waiting and Done statuses...');
          
          // Update to single space for these statuses
          const statusUpdates = [
            { from: '🤔  Waiting', to: '🤔 Waiting' },  // Single space
            { from: '✅  Done', to: '✅ Done' }  // Single space for compatibility
          ];
          
          for (const update of statusUpdates) {
            const result = db.prepare("UPDATE tasks SET status = ? WHERE status = ?").run(update.to, update.from);
            if (result.changes > 0) {
              console.log(`    Updated ${result.changes} tasks from '${update.from}' to '${update.to}'`);
            }
          }
          
          // Update status_groups_cache with correct spacing
          const statusGroups = {
            completeStatuses: ["✅ Done"],  // Single space for compatibility
            allGroups: [
              {
                name: "To-do",
                color: "gray",
                statuses: ["🗂️  To File", "1️⃣  1st Priority", "2️⃣  2nd Priority", "3️⃣  3rd Priority"]
              },
              {
                name: "In progress",
                color: "blue",
                statuses: ["🤔 Waiting", "⏸️  Paused"]  // Single space for Waiting
              },
              {
                name: "Complete",
                color: "green",
                statuses: ["✅ Done"]  // Single space for compatibility
              }
            ],
            options: [
              {id: "Y@is", name: "🗂️  To File", color: "orange", description: null},
              {id: "NEU`", name: "1️⃣  1st Priority", color: "red", description: null},
              {id: "|^g]", name: "2️⃣  2nd Priority", color: "orange", description: null},
              {id: "A=xG", name: "3️⃣  3rd Priority", color: "yellow", description: null},
              {id: "baef7a23-0323-4593-9bcd-71f7c9bf13a7", name: "🤔 Waiting", color: "purple", description: null},  // Single space
              {id: "e39cf1f3-937f-4836-b1e4-36bab92ee845", name: "⏸️  Paused", color: "gray", description: null},
              {id: "c7ecae0d-7571-4b0f-b639-d12b21f8792a", name: "✅ Done", color: "green", description: null}  // Single space for compatibility
            ]
          };
          
          // Update the status_groups_cache
          db.prepare("UPDATE status_groups_cache SET status_groups = ? WHERE database_id = ?").run(
            JSON.stringify(statusGroups),
            'de1740b0-2421-43a1-8bda-f177cec69e11'
          );
          
          console.log('    Fixed spacing: single space for Waiting and Done for code compatibility');
        }
      },
      {
        version: 18,
        description: 'Add trigger to auto-correct malformed dates on insert/update',
        fn: (db) => {
          console.log('    Adding trigger to auto-correct malformed dates...');
          
          // Create triggers to validate date format (YYYY-MM-DD)
          // Use GLOB to check for actual underscore character, not SQL LIKE wildcard
          db.exec(`
            CREATE TRIGGER IF NOT EXISTS fix_malformed_dates_insert
            BEFORE INSERT ON tasks
            FOR EACH ROW
            WHEN NEW.do_date IS NOT NULL AND 
                 (NEW.do_date GLOB '*_*' OR NEW.do_date NOT GLOB '????-??-??')
            BEGIN
              SELECT RAISE(FAIL, 'Invalid date format. Use YYYY-MM-DD format.');
            END;
            
            CREATE TRIGGER IF NOT EXISTS fix_malformed_dates_update
            BEFORE UPDATE ON tasks
            FOR EACH ROW
            WHEN NEW.do_date IS NOT NULL AND 
                 (NEW.do_date GLOB '*_*' OR NEW.do_date NOT GLOB '????-??-??')
            BEGIN
              SELECT RAISE(FAIL, 'Invalid date format. Use YYYY-MM-DD format.');
            END;
          `);
          
          console.log('    Added triggers to prevent malformed dates from being inserted or updated');
        }
      },
      {
        version: 19,
        description: 'Clean invalid task IDs and add constraint for valid hex IDs',
        fn: (db) => {
          console.log('    Cleaning invalid task IDs and adding constraints...');
          
          // First, delete any tasks with IDs that aren't 32-character hex strings
          // Valid IDs should be 36 chars (32 hex + 4 dashes) in format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
          // OR 32 chars without dashes (legacy format)
          const deleteInvalid = db.prepare(`
            DELETE FROM tasks 
            WHERE 
              -- Not 36 chars with dashes or 32 chars without
              (LENGTH(id) != 36 AND LENGTH(id) != 32)
              -- Or contains non-hex characters (excluding dashes for the 36-char format)
              OR (LENGTH(id) = 36 AND id NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
              OR (LENGTH(id) = 32 AND id NOT GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
              -- Or contains any of the known invalid IDs
              OR id IN ('activity-rings', 'tai-chi-watch', 'walk-steps')
          `);
          const deletedCount = deleteInvalid.run();
          console.log(`    Deleted ${deletedCount.changes} tasks with invalid IDs`);
          
          // Create a trigger to validate task IDs on insert
          db.exec(`
            CREATE TRIGGER IF NOT EXISTS validate_task_id_insert
            BEFORE INSERT ON tasks
            FOR EACH ROW
            BEGIN
              SELECT CASE
                -- Allow 36-char format with dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
                WHEN LENGTH(NEW.id) = 36 AND 
                     NEW.id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
                THEN NULL
                -- Allow 32-char format without dashes (legacy)
                WHEN LENGTH(NEW.id) = 32 AND 
                     NEW.id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
                THEN NULL
                ELSE RAISE(FAIL, 'Invalid task ID format. Must be 32 hex characters (with or without dashes).')
              END;
            END;
            
            CREATE TRIGGER IF NOT EXISTS validate_task_id_update
            BEFORE UPDATE OF id ON tasks
            FOR EACH ROW
            BEGIN
              SELECT CASE
                -- Allow 36-char format with dashes
                WHEN LENGTH(NEW.id) = 36 AND 
                     NEW.id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
                THEN NULL
                -- Allow 32-char format without dashes
                WHEN LENGTH(NEW.id) = 32 AND 
                     NEW.id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
                THEN NULL
                ELSE RAISE(FAIL, 'Invalid task ID format. Must be 32 hex characters (with or without dashes).')
              END;
            END;
          `);
          
          console.log('    Added triggers to validate task IDs on insert and update');
        }
      },
      {
        version: 20,
        description: 'Clean emoji prefixes from task titles',
        fn: (db) => {
          console.log('Migration v20: Cleaning emoji prefixes from task titles');
          
          // Define all status emojis that might be prefixed in titles
          const statusEmojis = [
            '🎭', '🗂️', '1️⃣', '2️⃣', '3️⃣', '📋', '✅', '⏳', '🔄', '❌', '✉️', '**'
          ];
          
          // First, let's see what we're dealing with
          const tasksWithEmojis = db.prepare(`
            SELECT id, title, status 
            FROM tasks 
            WHERE title LIKE '%🎭%' OR title LIKE '%🗂️%' 
               OR title LIKE '%1️⃣%' OR title LIKE '%2️⃣%' OR title LIKE '%3️⃣%'
               OR title LIKE '%📋%' OR title LIKE '%✅%' 
               OR title LIKE '%⏳%' OR title LIKE '%🔄%' OR title LIKE '%❌%'
               OR title LIKE '%✉️%'
          `).all();
          
          console.log(`    Found ${tasksWithEmojis.length} tasks with potential emoji prefixes`);
          
          const updateTitle = db.prepare('UPDATE tasks SET title = ? WHERE id = ?');
          let updatedCount = 0;
          
          for (const task of tasksWithEmojis) {
            let cleanTitle = task.title;
            
            // Remove leading status emojis and whitespace
            // Keep removing emojis from the start until none are left
            let previousTitle;
            do {
              previousTitle = cleanTitle;
              for (const emoji of statusEmojis) {
                if (cleanTitle.startsWith(emoji)) {
                  cleanTitle = cleanTitle.substring(emoji.length).trim();
                }
              }
            } while (cleanTitle !== previousTitle);
            
            // Also clean up any "**" markdown bold markers that might be left
            if (cleanTitle.startsWith('**') && cleanTitle.includes('**', 2)) {
              // Extract content between ** markers
              const endIndex = cleanTitle.indexOf('**', 2);
              const boldContent = cleanTitle.substring(2, endIndex);
              const afterBold = cleanTitle.substring(endIndex + 2).trim();
              cleanTitle = boldContent + (afterBold ? ' - ' + afterBold : '');
            }
            
            // Clean up trailing "DONE" markers
            cleanTitle = cleanTitle.replace(/\s*✅\s*DONE\s*-?\s*/gi, '');
            cleanTitle = cleanTitle.replace(/\s*\bDONE\b\s*$/i, '');
            
            if (cleanTitle !== task.title) {
              console.log(`      Updating task ${task.id.substring(0, 8)}...`);
              console.log(`        From: "${task.title}"`);
              console.log(`        To:   "${cleanTitle}"`);
              updateTitle.run(cleanTitle, task.id);
              updatedCount++;
            }
          }
          
          console.log(`    Updated ${updatedCount} task titles`);
        }
      },
      
      {
        version: 21,
        description: 'Fix invalid date strings - convert "null" string to actual NULL',
        fn: (db) => {
          console.log('Migration v21: Fixing invalid date strings');
          
          // Convert string 'null' to actual NULL
          const result = db.prepare(`
            UPDATE tasks 
            SET do_date = NULL 
            WHERE do_date = 'null' 
               OR do_date = 'undefined'
               OR do_date = ''
               OR (do_date IS NOT NULL AND LENGTH(TRIM(do_date)) = 0)
          `).run();
          
          console.log(`    Fixed ${result.changes} invalid date strings`);
          
          // Also fix any invalid date formats that don't match YYYY-MM-DD
          const invalidDates = db.prepare(`
            SELECT id, do_date FROM tasks 
            WHERE do_date IS NOT NULL 
              AND do_date != ''
              AND (
                LENGTH(do_date) != 10 
                OR do_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                OR SUBSTR(do_date, 5, 1) != '-'
                OR SUBSTR(do_date, 8, 1) != '-'
              )
          `).all();
          
          console.log(`    Found ${invalidDates.length} tasks with invalid date formats`);
          
          // Convert any malformed dates to NULL
          if (invalidDates.length > 0) {
            const fixMalformed = db.prepare(`
              UPDATE tasks 
              SET do_date = NULL 
              WHERE do_date IS NOT NULL 
                AND do_date != ''
                AND (
                  LENGTH(do_date) != 10 
                  OR do_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                  OR SUBSTR(do_date, 5, 1) != '-'
                  OR SUBSTR(do_date, 8, 1) != '-'
                )
            `).run();
            
            console.log(`    Fixed ${fixMalformed.changes} malformed dates`);
          }
        }
      },
      
      {
        version: 22,
        description: 'Convert weekly/quarterly date formats to proper dates',
        fn: (db) => {
          console.log('Migration v22: Converting invalid date formats to proper dates');
          
          // Fix dates with underscores, Q (quarter), or W (week) patterns
          const invalidPatterns = db.prepare(`
            SELECT id, do_date FROM tasks 
            WHERE do_date IS NOT NULL 
              AND (
                do_date LIKE '%_%'
                OR do_date LIKE '%Q%' 
                OR do_date LIKE '%W%'
              )
          `).all();
          
          console.log(`    Found ${invalidPatterns.length} tasks with invalid date patterns`);
          
          const updateDate = db.prepare('UPDATE tasks SET do_date = ? WHERE id = ?');
          let updated = 0;
          
          for (const task of invalidPatterns) {
            let newDate = null;
            const dateStr = task.do_date;
            
            // Parse patterns like "2025_Q3_08_W34_00" or "2025-Q3-08-18"
            // These appear to be: YYYY_Q[quarter]_MM_W[week]_DD or YYYY-Q[quarter]-MM-DD
            
            if (dateStr.includes('_')) {
              // Format: 2025_Q3_08_W34_00
              const parts = dateStr.split('_');
              if (parts.length >= 3) {
                const year = parts[0];
                const month = parts[2].padStart(2, '0');
                // Try to get day from last part, default to current day
                let day = parts[parts.length - 1];
                if (day === '00' || !day.match(/^\d{2}$/)) {
                  day = '03'; // Today is Sept 3
                }
                newDate = `${year}-${month}-${day.padStart(2, '0')}`;
              }
            } else if (dateStr.includes('Q')) {
              // Format: 2025-Q3-08-18
              const parts = dateStr.split('-');
              if (parts.length >= 3) {
                const year = parts[0];
                const month = parts[2].padStart(2, '0');
                const day = parts[3] || '03'; // Use provided day or today
                newDate = `${year}-${month}-${day.padStart(2, '0')}`;
              }
            }
            
            // Validate the date is reasonable (2024-2026)
            if (newDate && newDate.match(/^202[4-6]-\d{2}-\d{2}$/)) {
              console.log(`      Converting "${dateStr}" to "${newDate}"`);
              updateDate.run(newDate, task.id);
              updated++;
            } else {
              // If we can't parse it, set to today
              console.log(`      Converting unparseable "${dateStr}" to today's date`);
              updateDate.run('2025-09-03', task.id);
              updated++;
            }
          }
          
          console.log(`    Converted ${updated} invalid date formats`);
        }
      },
      {
        version: 23,
        description: 'Fix corrupted task titles with accumulated status emojis and remove duplicates',
        fn: (db) => {
          console.log('Migration v23: Fixing corrupted task titles and removing duplicates');
          
          // Define all status emojis/prefixes that should be removed from titles
          const statusPrefixes = [
            '🎭', '🗂️', '1️⃣', '2️⃣', '3️⃣', '📋', '✅', '⏳', '🔄', '❌', '✉️', 'Next'
          ];
          
          // Get all tasks with potentially corrupted titles
          const allTasks = db.prepare(`
            SELECT id, title, status, created_at 
            FROM tasks 
            ORDER BY title, created_at
          `).all();
          
          console.log(`    Checking ${allTasks.length} tasks for corrupted titles`);
          
          const updateTitle = db.prepare('UPDATE tasks SET title = ? WHERE id = ?');
          const deleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
          let fixedCount = 0;
          let deletedCount = 0;
          const cleanTitles = new Map(); // Map of clean title -> first task ID
          
          for (const task of allTasks) {
            let cleanTitle = task.title;
            
            // Keep removing status prefixes until none are left
            let previousTitle;
            do {
              previousTitle = cleanTitle;
              for (const prefix of statusPrefixes) {
                // Handle both "prefix " and just "prefix"
                if (cleanTitle.startsWith(prefix + ' ')) {
                  cleanTitle = cleanTitle.substring(prefix.length + 1).trim();
                } else if (cleanTitle.startsWith(prefix)) {
                  cleanTitle = cleanTitle.substring(prefix.length).trim();
                }
              }
            } while (cleanTitle !== previousTitle);
            
            // Also clean up duplicated topics (e.g., "👤 👤 👤" -> "👤")
            cleanTitle = cleanTitle.replace(/(\s*[👤💻🏠💪❤️✈️🧠📌🏥🌳💰🗂️]+)\s+\1+/g, '$1');
            
            // Check if this is a duplicate task (same clean title, not completed)
            const isDuplicate = cleanTitles.has(cleanTitle) && task.status !== '✅ Done';
            
            if (isDuplicate) {
              // This is a duplicate - delete it
              console.log(`        Deleting duplicate: "${task.title}" (ID: ${task.id.substring(0, 8)}...)`);
              deleteTask.run(task.id);
              deletedCount++;
            } else {
              // Mark this clean title as seen
              if (task.status !== '✅ Done') {
                cleanTitles.set(cleanTitle, task.id);
              }
              
              // Update the title if it was corrupted
              if (cleanTitle !== task.title) {
                console.log(`        Fixing: "${task.title}" -> "${cleanTitle}"`);
                updateTitle.run(cleanTitle, task.id);
                fixedCount++;
              }
            }
          }
          
          console.log(`    Fixed ${fixedCount} corrupted titles`);
          console.log(`    Deleted ${deletedCount} duplicate tasks`);
        }
      },
      {
        version: 24,
        description: 'Drop legacy task_cache table - no longer used since August 2025',
        fn: (db) => {
          console.log('    Dropping legacy task_cache table...');
          
          // Check if table exists
          const tableExists = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='task_cache'
          `).get();
          
          if (tableExists) {
            // Drop the table
            db.exec('DROP TABLE task_cache');
            console.log('    ✓ Dropped task_cache table');
            
            // Also clean up any related cache metadata
            const cacheMetaExists = db.prepare(`
              SELECT name FROM sqlite_master 
              WHERE type='table' AND name='cache_metadata'
            `).get();
            
            if (cacheMetaExists) {
              db.prepare("DELETE FROM cache_metadata WHERE cache_type = 'tasks'").run();
              console.log('    ✓ Cleaned up cache_metadata entries');
            }
          } else {
            console.log('    task_cache table already removed');
          }
        }
      },
      {
        version: 25,
        description: 'Create markdown_tasks cache table for Obsidian Tasks',
        fn: (db) => {
          console.log('    Creating markdown_tasks cache table...');

          // Create a new table for caching markdown tasks
          db.exec(`
            CREATE TABLE IF NOT EXISTS markdown_tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              file_path TEXT NOT NULL,
              line_number INTEGER NOT NULL,
              line_text TEXT NOT NULL,
              is_done BOOLEAN DEFAULT 0,
              scheduled_date DATE,
              due_date DATE,
              done_date DATE,
              priority INTEGER DEFAULT 0,
              tags TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(file_path, line_number)
            );

            -- Indexes for fast querying
            CREATE INDEX IF NOT EXISTS idx_markdown_tasks_file ON markdown_tasks(file_path);
            CREATE INDEX IF NOT EXISTS idx_markdown_tasks_done ON markdown_tasks(is_done);
            CREATE INDEX IF NOT EXISTS idx_markdown_tasks_scheduled ON markdown_tasks(scheduled_date);
            CREATE INDEX IF NOT EXISTS idx_markdown_tasks_due ON markdown_tasks(due_date);
            CREATE INDEX IF NOT EXISTS idx_markdown_tasks_done_date ON markdown_tasks(done_date);
            CREATE INDEX IF NOT EXISTS idx_markdown_tasks_priority ON markdown_tasks(priority);

            -- Trigger to update updated_at
            CREATE TRIGGER IF NOT EXISTS update_markdown_tasks_timestamp
              AFTER UPDATE ON markdown_tasks
              BEGIN
                UPDATE markdown_tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
              END;
          `);

          console.log('    ✓ Created markdown_tasks cache table with indexes');
        }
      },
      {
        version: 26,
        description: 'Simplify markdown_tasks table - remove parsing fields',
        fn: (db) => {
          console.log('    Simplifying markdown_tasks table...');

          // Drop the old table and recreate with simpler schema
          db.exec(`
            -- Drop existing indexes and triggers
            DROP TRIGGER IF EXISTS update_markdown_tasks_timestamp;
            DROP INDEX IF EXISTS idx_markdown_tasks_file;
            DROP INDEX IF EXISTS idx_markdown_tasks_done;
            DROP INDEX IF EXISTS idx_markdown_tasks_scheduled;
            DROP INDEX IF EXISTS idx_markdown_tasks_due;
            DROP INDEX IF EXISTS idx_markdown_tasks_done_date;
            DROP INDEX IF EXISTS idx_markdown_tasks_priority;

            -- Drop and recreate the table with simpler schema
            DROP TABLE IF EXISTS markdown_tasks;

            CREATE TABLE markdown_tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              file_path TEXT NOT NULL,
              line_number INTEGER NOT NULL,
              line_text TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(file_path, line_number)
            );

            -- Single index for file-based queries
            CREATE INDEX idx_markdown_tasks_file ON markdown_tasks(file_path);

            -- Trigger to update updated_at
            CREATE TRIGGER update_markdown_tasks_timestamp
              AFTER UPDATE ON markdown_tasks
              BEGIN
                UPDATE markdown_tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
              END;
          `);

          console.log('    ✓ Simplified markdown_tasks table');
        }
      },

      {
        version: 27,
        description: 'Clean up duplicate markdown_tasks with absolute paths',
        fn: (db) => {
          // Count duplicates before cleanup
          const duplicateCount = db.prepare(`
            SELECT COUNT(*) as count
            FROM markdown_tasks
            WHERE file_path LIKE '/opt/today/%'
          `).get().count;

          if (duplicateCount > 0) {
            console.log(`    Found ${duplicateCount} entries with absolute paths`);

            // Delete entries with absolute paths since relative paths are the standard
            db.exec(`
              DELETE FROM markdown_tasks
              WHERE file_path LIKE '/opt/today/%'
                 OR file_path LIKE '/workspaces/today/%'
            `);

            console.log('    ✓ Removed duplicate entries with absolute paths');
          } else {
            console.log('    ✓ No duplicate entries found');
          }
        }
      },
      {
        version: 28,
        description: 'Drop unused tables from legacy Notion sync system',
        fn: (db) => {
          console.log('    Dropping unused legacy tables...');

          const tablesToDrop = [
            'email_entity_mentions',
            'event_attendees',
            'ogm_honeybadger_faults',
            'project_topics',
            'summary_insights',
            'summary_meta',
            'summary_metrics',
            'summary_recommendations',
            'task_completions',
            'task_event_links',
            'task_projects',
            'task_relationships',
            'task_tags',
            'toggl_clients',
            'toggl_daily_summary',
            'toggl_project_summary',
            'toggl_tags'
          ];

          let droppedCount = 0;
          for (const table of tablesToDrop) {
            const exists = db.prepare(`
              SELECT name FROM sqlite_master
              WHERE type='table' AND name=?
            `).get(table);

            if (exists) {
              db.exec(`DROP TABLE ${table}`);
              console.log(`    ✓ Dropped ${table}`);
              droppedCount++;
            }
          }

          console.log(`    Dropped ${droppedCount} unused tables`);
        }
      },
      {
        version: 29,
        description: 'Drop legacy tasks and task_topics tables - now using markdown_tasks',
        fn: (db) => {
          console.log('    Dropping legacy Notion tasks tables...');

          const tablesToDrop = ['tasks', 'task_topics'];
          let droppedCount = 0;

          for (const table of tablesToDrop) {
            const exists = db.prepare(`
              SELECT name FROM sqlite_master
              WHERE type='table' AND name=?
            `).get(table);

            if (exists) {
              // Check if table has data
              const count = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
              console.log(`    Found ${count} rows in ${table} (legacy data)`);

              db.exec(`DROP TABLE ${table}`);
              console.log(`    ✓ Dropped ${table}`);
              droppedCount++;
            }
          }

          console.log(`    Dropped ${droppedCount} legacy task tables`);
          console.log('    ✓ Tasks are now tracked in markdown files via markdown_tasks table');
        }
      },
      {
        version: 30,
        description: 'Add time_entries table for markdown-based time tracking',
        fn: (db) => {
          console.log('    Creating time_entries table for time tracking...');

          db.exec(`
            CREATE TABLE IF NOT EXISTS time_entries (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              start_time DATETIME NOT NULL,
              end_time DATETIME,
              duration_minutes INTEGER,  -- Calculated from start_time/end_time during sync, not stored in markdown
              project TEXT NOT NULL,
              description TEXT,
              source TEXT DEFAULT 'markdown',
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(start_time, project, description)
            );

            CREATE INDEX IF NOT EXISTS idx_time_entries_start ON time_entries(start_time);
            CREATE INDEX IF NOT EXISTS idx_time_entries_project ON time_entries(project);
            CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(DATE(start_time));
          `);

          console.log('    ✓ Created time_entries table for markdown-based time tracking');
          console.log('    Note: Markdown format is START|END|DESCRIPTION (duration calculated on sync)');
        }
      },
      {
        version: 31,
        description: 'Replace project column with topics column for tag-based tracking',
        fn: (db) => {
          console.log('    Migrating from project to topics column...');

          // Add topics column
          db.exec(`ALTER TABLE time_entries ADD COLUMN topics TEXT;`);

          // Migrate existing data: copy project to topics
          db.exec(`UPDATE time_entries SET topics = project WHERE topics IS NULL;`);

          // Create index on topics
          db.exec(`CREATE INDEX IF NOT EXISTS idx_time_entries_topics ON time_entries(topics);`);

          // Drop old project index (keep column for backward compatibility during transition)
          db.exec(`DROP INDEX IF EXISTS idx_time_entries_project;`);

          console.log('    ✓ Added topics column and migrated data from project column');
          console.log('    Note: New markdown format is START|END|DESCRIPTION (with #topic/tags in description)');
          console.log('    Note: project column retained for backward compatibility, but topics is primary');
        }
      },
      {
        version: 32,
        description: 'Clean duplicate OGM GitHub issues and add unique constraint',
        fn: (db) => {
          console.log('    Cleaning duplicate OGM GitHub issues...');

          // Check if table exists
          const tableExists = db.prepare(`
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='ogm_github_issues'
          `).get();

          if (!tableExists) {
            console.log('    ✓ ogm_github_issues table does not exist (skipped)');
            return;
          }

          // Check for duplicates
          const duplicates = db.prepare(`
            SELECT number, COUNT(*) as cnt
            FROM ogm_github_issues
            GROUP BY number
            HAVING cnt > 1
          `).all();

          if (duplicates.length > 0) {
            console.log(`    Found ${duplicates.length} issue numbers with duplicates`);

            // Delete duplicate records, keeping only the most recent one (highest id)
            db.exec(`
              DELETE FROM ogm_github_issues
              WHERE id NOT IN (
                SELECT MAX(id)
                FROM ogm_github_issues
                GROUP BY number
              )
            `);

            console.log('    ✓ Removed duplicate issue records');
          } else {
            console.log('    No duplicates found');
          }

          // Add unique index on number column
          db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issue_number ON ogm_github_issues(number);`);

          console.log('    ✓ Added unique constraint on issue number');
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