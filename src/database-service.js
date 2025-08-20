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
      const result = this.localDb.prepare(`
        SELECT MAX(updated_at) as max_time FROM tasks
        UNION ALL
        SELECT MAX(created_at) FROM tasks
        UNION ALL
        SELECT MAX(completed_at) FROM tasks
        UNION ALL
        SELECT MAX(updated_at) FROM projects
      `).all();
      
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
    } catch (error) {
      return 0;
    }
  }
  
  /**
   * Get the most recent modification timestamp from Turso
   */
  async getTursoLastModified() {
    try {
      const result = await Promise.race([
        this.tursoClient.execute(`
          SELECT MAX(updated_at) as max_time FROM tasks
          UNION ALL
          SELECT MAX(created_at) FROM tasks
          UNION ALL
          SELECT MAX(completed_at) FROM tasks
          UNION ALL
          SELECT MAX(updated_at) FROM projects
        `),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
      ]);
      
      let maxTimestamp = 0;
      for (const row of result.rows) {
        if (row.max_time) {
          const timestamp = new Date(row.max_time).getTime();
          if (timestamp > maxTimestamp) {
            maxTimestamp = timestamp;
          }
        }
      }
      
      return maxTimestamp;
    } catch (error) {
      return null;
    }
  }

  /**
   * Pull data from Turso to local database
   */
  async pullFromTurso() {
    if (!this.tursoClient) return;
    
    try {
      // Focus on key tables only
      const SYNC_TABLES = ['tasks', 'projects', 'topics', 'task_topics', 'markdown_sync'];
      let totalRows = 0;
      
      for (const tableName of SYNC_TABLES) {
        try {
          const dataResult = await this.tursoClient.execute(`SELECT * FROM ${tableName}`);
          
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
          }
        } catch (e) {
          // Skip tables that might not exist
        }
      }
      
      if (totalRows > 0 && process.stderr.isTTY) {
        console.error(`✅ Pulled ${totalRows} rows from Turso`);
      }
    } catch (error) {
      if (process.stderr.isTTY) {
        console.error('⚠️  Pull failed:', error.message);
      }
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