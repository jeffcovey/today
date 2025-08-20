/**
 * Unified Database Service
 * All database access should go through this module
 * 
 * Features:
 * - Single point of database access
 * - Automatic Turso sync (pull/push)
 * - No schema recreation - assumes database exists
 * - Connection pooling via singleton pattern
 */

import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import dotenvx from '@dotenvx/dotenvx';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenvx.config();

// Singleton instance
let instance = null;

export class DatabaseService {
  constructor(dbPath = '.data/today.db', options = {}) {
    // Return existing instance if available (singleton pattern)
    if (instance && !options.forceNew) {
      return instance;
    }

    this.dbPath = path.resolve(dbPath);
    this.localDb = null;
    this.tursoClient = null;
    this.lastPullTime = null;
    this.lastPushTime = null;
    this.pushQueue = [];
    this.pushTimeout = null;
    this.pullCheckInterval = null;
    
    // Configuration
    this.readOnly = options.readOnly || false;
    this.autoSync = options.autoSync !== false; // Default true
    this.pullIntervalMs = options.pullIntervalMs || 60000; // 1 minute
    this.pushDelayMs = options.pushDelayMs || 2000; // 2 seconds
    
    this.init();
    
    // Store as singleton
    if (!options.forceNew) {
      instance = this;
    }
  }

  init() {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Open local database
    this.localDb = new Database(this.dbPath);
    this.localDb.pragma('journal_mode = WAL');
    this.localDb.pragma('busy_timeout = 30000');
    this.localDb.pragma('foreign_keys = OFF'); // Avoid issues during sync
    
    // Initialize Turso if configured and not read-only
    if (!this.readOnly && process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
      try {
        this.tursoClient = createClient({
          url: process.env.TURSO_DATABASE_URL,
          authToken: process.env.TURSO_AUTH_TOKEN
        });
        
        if (this.autoSync) {
          // Start periodic pull checks
          this.startPullCheckInterval();
          
          // Do initial pull check in background
          this.checkAndPull().catch(() => {
            // Ignore initial check errors
          });
        }
      } catch (error) {
        console.warn('⚠️  Turso initialization failed:', error.message);
      }
    }
  }

  /**
   * Get database instance (singleton pattern)
   */
  static getInstance(dbPath = '.data/today.db', options = {}) {
    if (!instance) {
      instance = new DatabaseService(dbPath, options);
    }
    return instance;
  }

  /**
   * Start periodic pull checks from Turso
   */
  startPullCheckInterval() {
    if (this.pullCheckInterval) return;
    
    this.pullCheckInterval = setInterval(() => {
      this.checkAndPull();
    }, this.pullIntervalMs);
  }

  /**
   * Stop periodic pull checks
   */
  stopPullCheckInterval() {
    if (this.pullCheckInterval) {
      clearInterval(this.pullCheckInterval);
      this.pullCheckInterval = null;
    }
  }

  /**
   * Check if we need to pull from Turso
   */
  async checkAndPull() {
    if (!this.tursoClient) return;
    
    try {
      // Get the most recent modification time from local DB
      const localLastModified = this.getLocalLastModified();
      
      // Get the most recent modification time from Turso
      const tursoLastModified = await this.getTursoLastModified();
      
      // If Turso has newer data, pull everything
      if (tursoLastModified && localLastModified && tursoLastModified > localLastModified) {
        if (process.stderr.isTTY) {
          console.error(`🔄 Syncing from Turso (newer data detected)...`);
        }
        await this.pullFromTurso();
      }
      
      this.lastPullTime = Date.now();
    } catch (error) {
      // Turso not reachable, continue with local
    }
  }
  
  /**
   * Get the most recent modification timestamp from local database
   */
  getLocalLastModified() {
    try {
      // Get all tables with timestamps
      const tables = this.localDb.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_litestream_%'
      `).all();
      
      let maxTimestamp = 0;
      
      for (const table of tables) {
        try {
          // Check multiple timestamp columns
          const queries = [
            `SELECT MAX(updated_at) as max_time FROM ${table.name}`,
            `SELECT MAX(created_at) as max_time FROM ${table.name}`,
            `SELECT MAX(completed_at) as max_time FROM ${table.name}`,
            `SELECT MAX(last_synced) as max_time FROM ${table.name}`
          ];
          
          for (const query of queries) {
            try {
              const result = this.localDb.prepare(query).get();
              if (result?.max_time) {
                const timestamp = new Date(result.max_time).getTime();
                if (timestamp > maxTimestamp) {
                  maxTimestamp = timestamp;
                }
              }
            } catch {
              // Column doesn't exist in this table
            }
          }
        } catch {
          // Table query failed
        }
      }
      
      return maxTimestamp;
    } catch (error) {
      return 0;
    }
  }
  
  /**
   * Get the most recent modification timestamp from Turso
   */
  async getTursoLastModified() {
    try {
      // Get list of tables from Turso
      const tablesResult = await this.tursoClient.execute(`
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_litestream_%'
      `);
      
      let maxTimestamp = 0;
      
      for (const table of tablesResult.rows) {
        try {
          // Check multiple timestamp columns
          const result = await Promise.race([
            this.tursoClient.execute(`
              SELECT MAX(updated_at) as max_time FROM ${table.name}
              UNION ALL
              SELECT MAX(created_at) FROM ${table.name}
              UNION ALL
              SELECT MAX(completed_at) FROM ${table.name}
              UNION ALL
              SELECT MAX(last_synced) FROM ${table.name}
            `),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1000))
          ]);
          
          for (const row of result.rows) {
            if (row.max_time) {
              const timestamp = new Date(row.max_time).getTime();
              if (timestamp > maxTimestamp) {
                maxTimestamp = timestamp;
              }
            }
          }
        } catch {
          // Table query failed or timed out
        }
      }
      
      return maxTimestamp > 0 ? maxTimestamp : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get list of tables to sync (all user tables)
   */
  async getSyncTables() {
    try {
      // Get all tables from local database
      const tables = this.localDb.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_litestream_%'
        ORDER BY name
      `).all();
      
      return tables.map(t => t.name);
    } catch (error) {
      // Fallback to essential tables if query fails
      return ['tasks', 'projects', 'topics', 'task_topics', 'markdown_sync'];
    }
  }

  /**
   * Pull data from Turso to local database
   */
  async pullFromTurso() {
    if (!this.tursoClient) return;
    
    try {
      // Get all tables dynamically
      const tables = await this.getSyncTables();
      let totalRows = 0;
      let syncedTables = 0;
      
      for (const tableName of tables) {
        try {
          // Only pull tables that have recent changes in Turso
          const tursoTimestamp = await this.getTableLastModified(tableName, true);
          const localTimestamp = await this.getTableLastModified(tableName, false);
          
          if (!tursoTimestamp || (localTimestamp && localTimestamp >= tursoTimestamp)) {
            continue; // Skip if local is already up to date
          }
          
          // Pull recent changes only (last 24 hours for efficiency)
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          let whereClause = '';
          let args = [];
          
          // Check if table has timestamp columns
          const hasTimestamp = await this.tableHasTimestamp(tableName);
          if (hasTimestamp) {
            whereClause = ` WHERE updated_at > ? OR created_at > ?`;
            args = [cutoff, cutoff];
          }
          
          const dataResult = await this.tursoClient.execute({
            sql: `SELECT * FROM ${tableName}${whereClause}`,
            args
          });
          
          if (dataResult.rows.length > 0) {
            const columns = Object.keys(dataResult.rows[0]);
            const placeholders = columns.map(() => '?').join(', ');
            
            const upsertSQL = `
              INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')})
              VALUES (${placeholders})
            `;
            
            const stmt = this.localDb.prepare(upsertSQL);
            
            const transaction = this.localDb.transaction(() => {
              for (const row of dataResult.rows) {
                const values = columns.map(col => row[col]);
                stmt.run(...values);
              }
            });
            
            transaction();
            totalRows += dataResult.rows.length;
            syncedTables++;
          }
        } catch (e) {
          // Skip tables that might not exist in Turso
        }
      }
      
      if (totalRows > 0 && process.stderr.isTTY) {
        console.error(`✅ Pulled ${totalRows} rows from ${syncedTables} tables`);
      }
    } catch (error) {
      if (process.stderr.isTTY) {
        console.error('⚠️  Pull failed:', error.message);
      }
    }
  }
  
  /**
   * Check if table has timestamp columns
   */
  async tableHasTimestamp(tableName) {
    try {
      const columns = this.localDb.prepare(`PRAGMA table_info(${tableName})`).all();
      return columns.some(c => 
        c.name === 'updated_at' || 
        c.name === 'created_at' || 
        c.name === 'last_synced'
      );
    } catch {
      return false;
    }
  }
  
  /**
   * Get last modified timestamp for a table
   */
  async getTableLastModified(tableName, fromTurso = false) {
    try {
      const db = fromTurso ? this.tursoClient : this.localDb;
      const query = `
        SELECT MAX(updated_at) as max_time FROM ${tableName}
        UNION ALL
        SELECT MAX(created_at) FROM ${tableName}
        UNION ALL
        SELECT MAX(last_synced) FROM ${tableName}
      `;
      
      let result;
      if (fromTurso) {
        const res = await db.execute(query);
        result = res.rows;
      } else {
        result = db.prepare(query).all();
      }
      
      let maxTimestamp = 0;
      for (const row of result) {
        if (row.max_time) {
          const timestamp = new Date(row.max_time).getTime();
          if (timestamp > maxTimestamp) {
            maxTimestamp = timestamp;
          }
        }
      }
      
      return maxTimestamp;
    } catch {
      return 0;
    }
  }

  /**
   * Queue a write operation for push to Turso
   */
  queuePush(sql, params) {
    if (!this.tursoClient || this.readOnly) return;
    
    // Don't queue transaction statements
    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
      return;
    }
    
    this.pushQueue.push({ sql, args: params || [] });
    
    // Debounce pushes
    if (this.pushTimeout) {
      clearTimeout(this.pushTimeout);
    }
    
    this.pushTimeout = setTimeout(() => {
      this.processPushQueue();
    }, this.pushDelayMs);
  }

  /**
   * Process queued push operations
   */
  async processPushQueue() {
    if (!this.tursoClient || this.pushQueue.length === 0) return;
    
    const operations = [...this.pushQueue];
    this.pushQueue = [];
    
    // Process in background
    setImmediate(async () => {
      let successCount = 0;
      let errorCount = 0;
      
      for (const op of operations) {
        try {
          await this.tursoClient.execute(op);
          successCount++;
        } catch (error) {
          errorCount++;
          if (!error.message.includes('UNIQUE constraint failed')) {
            console.warn('⚠️  Push error:', error.message.substring(0, 100));
          }
        }
      }
      
      if (successCount > 0 && process.stderr.isTTY) {
        console.error(`✅ Pushed ${successCount} changes to Turso`);
      }
      
      this.lastPushTime = Date.now();
    });
  }

  /**
   * Force push any pending changes immediately
   */
  async forcePush() {
    if (this.pushQueue.length > 0) {
      if (process.stderr.isTTY) {
        console.error(`📤 Pushing ${this.pushQueue.length} pending changes to Turso...`);
      }
      await this.processPushQueue();
    }
  }

  /**
   * Force pull from Turso immediately
   */
  async forcePull() {
    if (this.tursoClient) {
      console.log('🔄 Checking Turso for updates...');
      await this.checkAndPull();
    }
  }

  // === Database API Methods ===

  /**
   * Prepare a statement
   */
  prepare(sql) {
    return this.localDb.prepare(sql);
  }

  /**
   * Execute SQL (for CREATE TABLE, etc)
   * Note: Schema changes should be done through migrations, not here
   */
  exec(sql) {
    return this.localDb.exec(sql);
  }

  /**
   * Run a parameterized query
   */
  run(sql, ...params) {
    const stmt = this.localDb.prepare(sql);
    const result = stmt.run(...params);
    
    // Queue write operations for Turso
    const operation = sql.trim().toUpperCase().split(/\s+/)[0];
    if (['INSERT', 'UPDATE', 'DELETE'].includes(operation)) {
      this.queuePush(sql, params);
    }
    
    return result;
  }

  /**
   * Get a single row
   */
  get(sql, ...params) {
    const stmt = this.localDb.prepare(sql);
    return stmt.get(...params);
  }

  /**
   * Get all rows
   */
  all(sql, ...params) {
    const stmt = this.localDb.prepare(sql);
    return stmt.all(...params);
  }

  /**
   * Create a transaction
   */
  transaction(fn) {
    return this.localDb.transaction(fn);
  }

  /**
   * Close database connections
   */
  async close() {
    // Stop pull checks
    this.stopPullCheckInterval();
    
    // Process any remaining pushes
    if (this.pushTimeout) {
      clearTimeout(this.pushTimeout);
      await this.processPushQueue();
    }
    
    if (this.localDb) {
      this.localDb.close();
      this.localDb = null;
    }
    
    if (this.tursoClient) {
      this.tursoClient = null;
    }
    
    // Clear singleton instance if it's this one
    if (instance === this) {
      instance = null;
    }
  }

  /**
   * Check if we're connected to Turso
   */
  isConnectedToTurso() {
    return this.tursoClient !== null;
  }

  /**
   * Get sync status
   */
  async getSyncStatus() {
    if (!this.tursoClient) {
      return {
        connected: false,
        mode: 'local-only',
        message: 'Running in local-only mode'
      };
    }

    try {
      await this.tursoClient.execute('SELECT 1');
      return {
        connected: true,
        mode: 'turso-sync',
        syncUrl: process.env.TURSO_DATABASE_URL,
        message: 'Connected to Turso with automatic sync'
      };
    } catch (error) {
      return {
        connected: false,
        mode: 'local-only',
        error: error.message,
        message: 'Turso connection failed, running locally'
      };
    }
  }
}

// Export singleton getter
export function getDatabase(dbPath = '.data/today.db', options = {}) {
  return DatabaseService.getInstance(dbPath, options);
}

// Export default singleton instance
export default DatabaseService.getInstance();