import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import fs from 'fs';
import path from 'path';

/**
 * Optimized Turso sync using high water mark approach
 * Tracks last sync time and only syncs data newer than that
 */
export class TursoSyncOptimized {
  constructor(localDbPath = '.data/today.db') {
    this.localDbPath = localDbPath;
    this.syncStateFile = '.data/turso-sync-state.json';
    this.localDb = null;
    this.tursoClient = null;
    this.syncState = this.loadSyncState();
  }

  loadSyncState() {
    try {
      if (fs.existsSync(this.syncStateFile)) {
        return JSON.parse(fs.readFileSync(this.syncStateFile, 'utf8'));
      }
    } catch (e) {
      console.error('Failed to load sync state:', e.message);
    }
    return {
      lastPullTime: null,
      lastPushTime: null,
      tableWatermarks: {}
    };
  }

  saveSyncState() {
    try {
      const dir = path.dirname(this.syncStateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.syncStateFile, JSON.stringify(this.syncState, null, 2));
    } catch (e) {
      console.error('Failed to save sync state:', e.message);
    }
  }

  async init() {
    // Initialize local database
    if (fs.existsSync(this.localDbPath)) {
      this.localDb = new Database(this.localDbPath);
      this.localDb.pragma('journal_mode = WAL');
    }

    // Initialize Turso client
    if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
      this.tursoClient = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN
      });
    }
  }

  /**
   * Get the maximum timestamp from both databases for a quick comparison
   */
  async getGlobalWatermarks() {
    const watermarks = {
      local: {},
      turso: {}
    };

    // Tables with timestamp columns we care about
    const timestampTables = [
      { name: 'tasks', columns: ['updated_at', 'created_at'] },
      { name: 'projects', columns: ['updated_at', 'created_at'] },
      { name: 'emails', columns: ['date'] },
      { name: 'calendar_events', columns: ['updated_at', 'created_at'] },
      { name: 'contacts', columns: ['updated_at'] },
      { name: 'markdown_sync', columns: ['last_synced'] },
      { name: 'task_completions', columns: ['completed_at'] }
    ];

    // Get local watermarks
    if (this.localDb) {
      for (const table of timestampTables) {
        try {
          // Build query to get max of all timestamp columns
          const maxExpressions = table.columns.map(col => `MAX(${col})`).join(', ');
          const query = `SELECT ${maxExpressions} FROM ${table.name}`;
          const result = this.localDb.prepare(query).get();
          
          // Find the actual maximum across all columns
          let maxTime = null;
          for (const col of table.columns) {
            const value = result[`MAX(${col})`];
            if (value && (!maxTime || value > maxTime)) {
              maxTime = value;
            }
          }
          
          if (maxTime) {
            watermarks.local[table.name] = maxTime;
          }
        } catch (e) {
          // Table might not exist
        }
      }
    }

    // Get Turso watermarks
    if (this.tursoClient) {
      for (const table of timestampTables) {
        try {
          // Build query to get max of all timestamp columns
          const maxExpressions = table.columns.map(col => `MAX(${col}) as max_${col}`).join(', ');
          const query = `SELECT ${maxExpressions} FROM ${table.name}`;
          const result = await this.tursoClient.execute(query);
          
          if (result.rows && result.rows[0]) {
            // Find the actual maximum across all columns
            let maxTime = null;
            for (const col of table.columns) {
              const value = result.rows[0][`max_${col}`];
              if (value && (!maxTime || value > maxTime)) {
                maxTime = value;
              }
            }
            
            if (maxTime) {
              watermarks.turso[table.name] = maxTime;
            }
          }
        } catch (e) {
          // Table might not exist
        }
      }
    }

    return watermarks;
  }

  /**
   * Smart pull - only pull data newer than our last sync
   */
  async smartPull() {
    console.log('🔄 Smart pull from Turso...');
    
    const watermarks = await this.getGlobalWatermarks();
    let pulledRows = 0;
    
    // For each table, pull only rows newer than local watermark
    for (const [tableName, tursoWatermark] of Object.entries(watermarks.turso)) {
      const localWatermark = watermarks.local[tableName];
      
      // Skip if Turso has no newer data
      if (localWatermark && tursoWatermark <= localWatermark) {
        console.log(`  ${tableName}: up to date`);
        continue;
      }
      
      // Determine the cutoff time
      const cutoff = localWatermark || 
        this.syncState.tableWatermarks[tableName] || 
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // Default to 30 days ago
      
      console.log(`  ${tableName}: pulling changes since ${new Date(cutoff).toLocaleString()}`);
      
      // Pull the changes
      const rowsPulled = await this.pullTableChanges(tableName, cutoff);
      pulledRows += rowsPulled;
      
      // Update watermark
      this.syncState.tableWatermarks[tableName] = tursoWatermark;
    }
    
    this.syncState.lastPullTime = new Date().toISOString();
    this.saveSyncState();
    
    console.log(`✅ Pulled ${pulledRows} total changes`);
    return pulledRows;
  }

  /**
   * Pull only changed rows from a specific table
   */
  async pullTableChanges(tableName, sinceTimestamp) {
    // Determine which timestamp column to use
    const timestampColumns = {
      'tasks': 'COALESCE(updated_at, created_at)',
      'projects': 'COALESCE(updated_at, created_at)',
      'emails': 'date',
      'calendar_events': 'COALESCE(updated_at, created_at)',
      'contacts': 'updated_at',
      'markdown_sync': 'last_synced',
      'task_completions': 'completed_at'
    };
    
    const timestampCol = timestampColumns[tableName];
    if (!timestampCol) {
      // No timestamp column, skip incremental sync
      return 0;
    }
    
    try {
      // Count changes first
      const countResult = await this.tursoClient.execute({
        sql: `SELECT COUNT(*) as count FROM ${tableName} WHERE ${timestampCol} > ?`,
        args: [sinceTimestamp]
      });
      
      const totalChanges = countResult.rows[0]?.count || 0;
      if (totalChanges === 0) return 0;
      
      // Pull in batches
      const BATCH_SIZE = 500;
      let offset = 0;
      let pulledRows = 0;
      
      while (offset < totalChanges) {
        const result = await this.tursoClient.execute({
          sql: `SELECT * FROM ${tableName} WHERE ${timestampCol} > ? ORDER BY ${timestampCol} LIMIT ? OFFSET ?`,
          args: [sinceTimestamp, BATCH_SIZE, offset]
        });
        
        if (result.rows.length === 0) break;
        
        // Upsert the rows
        this.upsertRows(tableName, result.rows);
        pulledRows += result.rows.length;
        offset += BATCH_SIZE;
        
        if (totalChanges > 100) {
          console.log(`    ${tableName}: ${pulledRows}/${totalChanges} rows`);
        }
      }
      
      return pulledRows;
    } catch (e) {
      console.error(`    Error pulling ${tableName}: ${e.message}`);
      return 0;
    }
  }

  /**
   * Smart push - only push data newer than last sync
   */
  async smartPush() {
    console.log('📤 Smart push to Turso...');
    
    const watermarks = await this.getGlobalWatermarks();
    let pushedRows = 0;
    
    // For each table, push only rows newer than Turso watermark
    for (const [tableName, localWatermark] of Object.entries(watermarks.local)) {
      const tursoWatermark = watermarks.turso[tableName];
      
      // Skip if local has no newer data
      if (tursoWatermark && localWatermark <= tursoWatermark) {
        console.log(`  ${tableName}: up to date`);
        continue;
      }
      
      // Determine the cutoff time
      const cutoff = tursoWatermark || 
        this.syncState.tableWatermarks[tableName] || 
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // Default to 7 days ago
      
      console.log(`  ${tableName}: pushing changes since ${new Date(cutoff).toLocaleString()}`);
      
      // Push the changes
      const rowsPushed = await this.pushTableChanges(tableName, cutoff);
      pushedRows += rowsPushed;
      
      // Update watermark
      this.syncState.tableWatermarks[tableName] = localWatermark;
    }
    
    this.syncState.lastPushTime = new Date().toISOString();
    this.saveSyncState();
    
    console.log(`✅ Pushed ${pushedRows} total changes`);
    return pushedRows;
  }

  /**
   * Push only changed rows from a specific table
   */
  async pushTableChanges(tableName, sinceTimestamp) {
    // Determine which timestamp column to use
    const timestampColumns = {
      'tasks': 'COALESCE(updated_at, created_at)',
      'projects': 'COALESCE(updated_at, created_at)',
      'emails': 'date',
      'calendar_events': 'COALESCE(updated_at, created_at)',
      'contacts': 'updated_at',
      'markdown_sync': 'last_synced',
      'task_completions': 'completed_at'
    };
    
    const timestampCol = timestampColumns[tableName];
    if (!timestampCol) {
      // No timestamp column, skip incremental sync
      return 0;
    }
    
    try {
      // Get changes from local
      const rows = this.localDb.prepare(`
        SELECT * FROM ${tableName} 
        WHERE ${timestampCol} > ?
        ORDER BY ${timestampCol}
      `).all(sinceTimestamp);
      
      if (rows.length === 0) return 0;
      
      // Push in batches using batch execute for speed
      const BATCH_SIZE = 100;
      let pushedRows = 0;
      
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, Math.min(i + BATCH_SIZE, rows.length));
        
        // Build batch of statements
        const statements = [];
        for (const row of batch) {
          const columns = Object.keys(row);
          const placeholders = columns.map(() => '?').join(', ');
          const sql = `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
          
          statements.push({
            sql,
            args: Object.values(row)
          });
        }
        
        try {
          // Execute batch in a single request
          if (statements.length === 1) {
            // Single statement
            await this.tursoClient.execute(statements[0]);
            pushedRows++;
          } else {
            // Multiple statements - use batch
            await this.tursoClient.batch(statements);
            pushedRows += statements.length;
          }
        } catch (e) {
          // On batch error, fall back to individual inserts
          for (const stmt of statements) {
            try {
              await this.tursoClient.execute(stmt);
              pushedRows++;
            } catch (individualError) {
              // Skip individual errors
            }
          }
        }
        
        if (rows.length > 100 && (i + BATCH_SIZE) % 500 === 0) {
          console.log(`    ${tableName}: ${pushedRows}/${rows.length} rows`);
        }
      }
      
      return pushedRows;
    } catch (e) {
      console.error(`    Error pushing ${tableName}: ${e.message}`);
      return 0;
    }
  }

  /**
   * Helper to upsert rows into local database
   */
  upsertRows(tableName, rows) {
    if (rows.length === 0) return;
    
    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
    
    const stmt = this.localDb.prepare(sql);
    const transaction = this.localDb.transaction(() => {
      for (const row of rows) {
        stmt.run(...Object.values(row));
      }
    });
    
    transaction();
  }

  /**
   * Quick sync status check
   */
  async status() {
    const watermarks = await this.getGlobalWatermarks();
    
    console.log('\n📊 Sync Status:');
    console.log('─'.repeat(50));
    
    const tables = new Set([...Object.keys(watermarks.local), ...Object.keys(watermarks.turso)]);
    
    for (const table of tables) {
      const local = watermarks.local[table];
      const turso = watermarks.turso[table];
      
      if (!local && !turso) continue;
      
      let status;
      if (!local) {
        status = '⬇️  Need pull (no local data)';
      } else if (!turso) {
        status = '⬆️  Need push (no Turso data)';
      } else if (local > turso) {
        status = '⬆️  Local is newer';
      } else if (turso > local) {
        status = '⬇️  Turso is newer';
      } else {
        status = '✅ In sync';
      }
      
      console.log(`${table.padEnd(20)} ${status}`);
      if (local) console.log(`  Local:  ${new Date(local).toLocaleString()}`);
      if (turso) console.log(`  Turso:  ${new Date(turso).toLocaleString()}`);
    }
    
    console.log('─'.repeat(50));
    
    if (this.syncState.lastPullTime) {
      console.log(`Last pull: ${new Date(this.syncState.lastPullTime).toLocaleString()}`);
    }
    if (this.syncState.lastPushTime) {
      console.log(`Last push: ${new Date(this.syncState.lastPushTime).toLocaleString()}`);
    }
  }
}

// Export for use in other modules
export async function smartTursoSync(direction = 'both') {
  const sync = new TursoSyncOptimized();
  await sync.init();
  
  let result = { pulled: 0, pushed: 0 };
  
  if (direction === 'pull' || direction === 'both') {
    result.pulled = await sync.smartPull();
  }
  
  if (direction === 'push' || direction === 'both') {
    result.pushed = await sync.smartPush();
  }
  
  return result;
}

// Export status check
export async function tursoSyncStatus() {
  const sync = new TursoSyncOptimized();
  await sync.init();
  await sync.status();
}