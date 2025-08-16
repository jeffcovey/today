import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import dotenvx from '@dotenvx/dotenvx';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenvx.config();

/**
 * Database Sync Manager
 * Wraps all database operations with automatic Turso sync
 * - Periodic pull checks (not on every read)
 * - Immediate local operations
 * - Batched background push after writes
 */
export class DatabaseSync {
  constructor(localPath = '.data/today.db', options = {}) {
    this.localPath = localPath;
    this.localDb = null;
    this.tursoClient = null;
    this.lastPullTime = null;
    this.lastPushTime = null;
    this.pushQueue = [];
    this.pushTimeout = null;
    this.pullCheckInterval = null;
    
    // Sync settings
    this.PULL_CHECK_INTERVAL_MS = 60000; // Check Turso every 60 seconds
    this.PUSH_DELAY_MS = 2000; // Push 2 seconds after last write
    
    // Options
    this.readOnly = options.readOnly || false; // Skip Turso init for read-only operations
    
    this.init();
  }

  init() {
    // Ensure directory exists
    const dir = path.dirname(this.localPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Open local database
    this.localDb = new Database(this.localPath);
    this.localDb.pragma('journal_mode = WAL');
    this.localDb.pragma('busy_timeout = 30000');
    
    // Initialize Turso if configured and not read-only
    if (!this.readOnly && process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
      try {
        this.tursoClient = createClient({
          url: process.env.TURSO_DATABASE_URL,
          authToken: process.env.TURSO_AUTH_TOKEN
        });
        
        // Start periodic pull checks
        this.startPullCheckInterval();
        
        // Do initial pull check
        this.checkAndPull().catch(() => {
          // Ignore initial check errors
        });
      } catch (error) {
        console.warn('⚠️  Turso initialization failed:', error.message);
      }
    }
  }

  /**
   * Start periodic pull checks
   */
  startPullCheckInterval() {
    if (this.pullCheckInterval) return;
    
    // Check every minute
    this.pullCheckInterval = setInterval(() => {
      this.checkAndPull();
    }, this.PULL_CHECK_INTERVAL_MS);
  }

  /**
   * Check if we need to pull from Turso
   */
  async checkAndPull() {
    if (!this.tursoClient) return;
    
    try {
      // Get the most recent modification time from any table in local DB
      const localLastModified = this.getLocalLastModified();
      
      // Get the most recent modification time from Turso
      const tursoLastModified = await this.getTursoLastModified();
      
      // If Turso has newer data, pull everything
      if (tursoLastModified && localLastModified && tursoLastModified > localLastModified) {
        if (process.stderr.isTTY) {
          console.error(`🔄 Syncing from Turso (newer data detected)...`);
        }
        await this.pullAllTables();
      }
      
      this.lastPullTime = Date.now();
    } catch (error) {
      // Turso not reachable, continue with local
      // Silently continue - don't spam console
    }
  }
  
  /**
   * Get the most recent modification timestamp from local database
   */
  getLocalLastModified() {
    try {
      // Check all tables that have updated_at or created_at columns
      const tables = this.localDb.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        AND name NOT LIKE 'sqlite_%'
      `).all();
      
      let maxTimestamp = 0;
      
      for (const table of tables) {
        // Try to get the latest timestamp from each table
        try {
          const result = this.localDb.prepare(`
            SELECT MAX(
              COALESCE(updated_at, created_at, last_synced, cached_at, completed_at, 0)
            ) as max_time 
            FROM ${table.name}
          `).get();
          
          if (result?.max_time) {
            const timestamp = new Date(result.max_time).getTime();
            if (timestamp > maxTimestamp) {
              maxTimestamp = timestamp;
            }
          }
        } catch (e) {
          // Table might not have timestamp columns, continue
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
          SELECT name FROM sqlite_master 
          WHERE type='table' 
          AND name NOT LIKE 'sqlite_%'
        `),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
      ]);
      
      let maxTimestamp = 0;
      
      for (const row of result.rows) {
        try {
          const tableResult = await this.tursoClient.execute(`
            SELECT MAX(
              COALESCE(updated_at, created_at, last_synced, cached_at, completed_at, 0)
            ) as max_time 
            FROM ${row.name}
          `);
          
          if (tableResult.rows[0]?.max_time) {
            const timestamp = new Date(tableResult.rows[0].max_time).getTime();
            if (timestamp > maxTimestamp) {
              maxTimestamp = timestamp;
            }
          }
        } catch (e) {
          // Table might not have timestamp columns, continue
        }
      }
      
      return maxTimestamp;
    } catch (error) {
      return null;
    }
  }

  /**
   * Pull all tables from Turso
   */
  async pullAllTables() {
    if (!this.tursoClient) return;
    
    try {
      // Get list of all tables from Turso
      const tablesResult = await this.tursoClient.execute(`
        SELECT name, sql FROM sqlite_master 
        WHERE type='table' 
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_litestream_%'
      `);
      
      let totalRows = 0;
      const LARGE_TABLES = ['emails', 'calendar_events', 'contact_addresses', 'contacts'];
      
      for (const table of tablesResult.rows) {
        const tableName = table.name;
        
        try {
          // For large tables, pull in batches to avoid 502 errors
          if (LARGE_TABLES.includes(tableName)) {
            // Get count first
            const countResult = await this.tursoClient.execute(`SELECT COUNT(*) as count FROM ${tableName}`);
            const tableRowCount = countResult.rows[0]?.count || 0;
            
            if (tableRowCount === 0) continue;
            
            // Pull in smaller batches
            const BATCH_SIZE = 500;
            let offset = 0;
            let tableData = [];
            
            while (offset < tableRowCount) {
              try {
                const batchResult = await this.tursoClient.execute({
                  sql: `SELECT * FROM ${tableName} LIMIT ? OFFSET ?`,
                  args: [BATCH_SIZE, offset]
                });
                
                if (batchResult.rows.length === 0) break;
                tableData.push(...batchResult.rows);
                offset += BATCH_SIZE;
                
                // Small delay to avoid rate limiting
                if (offset < tableRowCount) {
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
              } catch (batchError) {
                if (process.stderr.isTTY) {
                  console.error(`⚠️  Error pulling batch from ${tableName}: ${batchError.message.substring(0, 50)}`);
                }
                break;
              }
            }
            
            // Process the collected data
            if (tableData.length > 0) {
              const columns = Object.keys(tableData[0]);
              const placeholders = columns.map(() => '?').join(', ');
              
              const upsertSQL = `
                INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')})
                VALUES (${placeholders})
              `;
              
              const stmt = this.localDb.prepare(upsertSQL);
              
              // Insert in transaction
              const transaction = this.localDb.transaction(() => {
                for (const row of tableData) {
                  const values = columns.map(col => row[col]);
                  stmt.run(...values);
                }
              });
              
              transaction();
              totalRows += tableData.length;
            }
          } else {
            // For small tables, pull all at once
            const dataResult = await this.tursoClient.execute(`SELECT * FROM ${tableName}`);
            
            if (dataResult.rows.length > 0) {
              // Get column names from the first row
              const columns = Object.keys(dataResult.rows[0]);
              const placeholders = columns.map(() => '?').join(', ');
              
              // Prepare upsert statement
              const upsertSQL = `
                INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')})
                VALUES (${placeholders})
              `;
              
              const stmt = this.localDb.prepare(upsertSQL);
              
              // Insert all rows in a transaction
              const transaction = this.localDb.transaction(() => {
                for (const row of dataResult.rows) {
                  const values = columns.map(col => row[col]);
                  stmt.run(...values);
                }
              });
              
              transaction();
              totalRows += dataResult.rows.length;
            }
          }
        } catch (e) {
          // Skip tables that might have issues
          if (process.stderr.isTTY && !e.message.includes('no such table')) {
            console.error(`⚠️  Skipped table ${tableName}: ${e.message.substring(0, 50)}`);
          }
        }
      }
      
      if (totalRows > 0 && process.stderr.isTTY) {
        console.error(`✅ Pulled ${totalRows} total rows from Turso`);
      }
    } catch (error) {
      if (process.stderr.isTTY && !error.message.includes('database connection')) {
        console.error('⚠️  Pull failed:', error.message);
      }
    }
  }

  /**
   * Queue a write operation for push to Turso
   */
  queuePush(sql, params) {
    if (!this.tursoClient) return;
    
    // Don't queue if it's a transaction statement
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
    }, this.PUSH_DELAY_MS);
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
          // Only log specific errors, not all
          if (!error.message.includes('UNIQUE constraint failed')) {
            console.warn('⚠️  Push error:', error.message.substring(0, 100));
          }
        }
      }
      
      if (successCount > 0 && process.stderr.isTTY) {
        console.error(`✅ Pushed ${successCount} changes to Turso`);
      }
      if (errorCount > 0 && errorCount !== operations.length && process.stderr.isTTY) {
        console.error(`⚠️  ${errorCount} operations skipped (likely duplicates)`);
      }
      
      this.lastPushTime = Date.now();
    });
  }

  /**
   * Prepare a statement
   */
  prepare(sql) {
    return this.localDb.prepare(sql);
  }

  /**
   * Execute SQL (for CREATE TABLE, etc)
   */
  exec(sql) {
    const result = this.localDb.exec(sql);
    
    // Don't try to sync schema changes - Turso should already have schema
    // This avoids SQL parsing errors
    
    return result;
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
   * Close database connections
   */
  close() {
    // Stop pull checks
    if (this.pullCheckInterval) {
      clearInterval(this.pullCheckInterval);
      this.pullCheckInterval = null;
    }
    
    // Process any remaining pushes
    if (this.pushTimeout) {
      clearTimeout(this.pushTimeout);
      this.processPushQueue();
    }
    
    if (this.localDb) {
      this.localDb.close();
    }
  }
}

// Export singleton instances (separate for read-only and read-write)
let rwInstance = null;
let roInstance = null;

export function getDatabaseSync(localPath, options = {}) {
  if (options.readOnly) {
    if (!roInstance) {
      roInstance = new DatabaseSync(localPath, { readOnly: true });
    }
    return roInstance;
  } else {
    if (!rwInstance) {
      rwInstance = new DatabaseSync(localPath, { readOnly: false });
    }
    return rwInstance;
  }
}

/**
 * Force push any pending changes to Turso and wait for completion
 * Used by CLI tools before they exit
 */
export async function forcePushToTurso(dbPath = '.data/today.db') {
  const db = getDatabaseSync(dbPath);
  
  if (!db.tursoClient) {
    // No Turso configured
    return;
  }
  
  // Process any pending pushes immediately if they exist
  if (db.pushQueue && db.pushQueue.length > 0) {
    console.log(`📤 Pushing ${db.pushQueue.length} pending changes to Turso...`);
    try {
      await db.processPushQueue();
    } catch (error) {
      // Log but don't fail - these are likely duplicate key errors
      if (!error.message.includes('UNIQUE constraint')) {
        console.warn('⚠️  Some changes could not be pushed:', error.message);
      }
    }
  }
}

/**
 * Force pull from Turso to ensure we have latest data
 * Used at the start of sync operations
 */
export async function forcePullFromTurso(dbPath = '.data/today.db') {
  const db = getDatabaseSync(dbPath);
  
  if (!db.tursoClient) {
    // No Turso configured
    return;
  }
  
  console.log('🔄 Checking Turso for updates...');
  await db.checkAndPull();
}