/**
 * Unified Database Service
 * All database access should go through this module
 *
 * Features:
 * - Single point of database access
 * - Local SQLite database
 * - No schema recreation - assumes database exists
 * - Connection pooling via singleton pattern
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

// Load environment variables only if .env exists (to avoid warnings)
if (fs.existsSync(path.join(projectRoot, '.env'))) {
  const dotenvx = await import('@dotenvx/dotenvx');
  dotenvx.default.config({ quiet: true });
}

// Singleton instance
let instance = null;

// Track if we've set up signal handlers
let signalHandlersInstalled = false;

/**
 * Install signal handlers to properly close database on exit
 * This prevents WAL corruption from incomplete checkpoints
 */
function installSignalHandlers() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const cleanup = () => {
    if (instance) {
      try {
        // Force a WAL checkpoint before closing
        instance.localDb?.pragma('wal_checkpoint(TRUNCATE)');
        instance.localDb?.close();
      } catch {
        // Ignore errors during cleanup
      }
      instance = null;
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
}

export class DatabaseService {
  constructor(dbPath = '.data/today.db', options = {}) {
    // Return existing instance if available (singleton pattern)
    if (instance && !options.forceNew) {
      return instance;
    }

    this.dbPath = path.resolve(dbPath);
    this.localDb = null;

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

    // Open local database with timeout option (prevents blocking on open)
    this.localDb = new Database(this.dbPath, {
      timeout: 30000  // 30 seconds - wait for locks before failing
    });
    this.localDb.pragma('journal_mode = WAL');
    this.localDb.pragma('busy_timeout = 30000');
    this.localDb.pragma('foreign_keys = OFF');

    // Record the file's inode so we can detect replacement
    try {
      this._dbIno = fs.statSync(this.dbPath).ino;
    } catch {
      this._dbIno = null;
    }
    this._lastInodeCheck = Date.now();

    // Install signal handlers to ensure clean shutdown
    installSignalHandlers();
  }

  /**
   * Check if the database file has been replaced (different inode).
   * Checks at most once every 10 seconds to avoid stat overhead.
   * If the file was replaced, automatically reopens the connection.
   */
  _checkFileReplaced() {
    const now = Date.now();
    if (now - this._lastInodeCheck < 10_000) return;
    this._lastInodeCheck = now;

    try {
      const currentIno = fs.statSync(this.dbPath).ino;
      if (this._dbIno !== null && currentIno !== this._dbIno) {
        console.log(`Database file replaced (inode ${this._dbIno} → ${currentIno}), reopening connection`);
        this.refresh();
      }
    } catch {
      // File may not exist yet during rebuild; ignore
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


  // === Database API Methods ===

  /**
   * Prepare a statement
   */
  prepare(sql) {
    this._checkFileReplaced();
    return this.localDb.prepare(sql);
  }

  /**
   * Execute SQL (for CREATE TABLE, etc)
   * Note: Schema changes should be done through migrations, not here
   */
  exec(sql) {
    this._checkFileReplaced();
    return this.localDb.exec(sql);
  }

  /**
   * Run a parameterized query
   */
  run(sql, ...params) {
    this._checkFileReplaced();
    const stmt = this.localDb.prepare(sql);
    return stmt.run(...params);
  }

  /**
   * Get a single row
   */
  get(sql, ...params) {
    this._checkFileReplaced();
    const stmt = this.localDb.prepare(sql);
    return stmt.get(...params);
  }

  /**
   * Get all rows
   */
  all(sql, ...params) {
    this._checkFileReplaced();
    const stmt = this.localDb.prepare(sql);
    return stmt.all(...params);
  }

  /**
   * Create a transaction
   */
  transaction(fn) {
    this._checkFileReplaced();
    return this.localDb.transaction(fn);
  }

  /**
   * Execute a pragma command
   */
  pragma(sql, options) {
    this._checkFileReplaced();
    return this.localDb.pragma(sql, options);
  }

  /**
   * Refresh the database connection to ensure fresh view of data.
   * Call this after subprocess writes to ensure WAL changes are visible.
   */
  refresh() {
    if (this.localDb) {
      this.localDb.close();
    }
    this.init();
  }

  /**
   * Close database connections
   */
  async close() {
    if (this.localDb) {
      this.localDb.close();
      this.localDb = null;
    }

    // Clear singleton instance if it's this one
    if (instance === this) {
      instance = null;
    }
  }
}

// Export singleton getter
export function getDatabase(dbPath = '.data/today.db', options = {}) {
  return DatabaseService.getInstance(dbPath, options);
}