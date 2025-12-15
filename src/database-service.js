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
    return stmt.run(...params);
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
   * Execute a pragma command
   */
  pragma(sql, options) {
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