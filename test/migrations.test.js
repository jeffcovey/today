import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { MigrationManager } from '../src/migrations.js';

describe('Database Migrations', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    // Create a temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-test-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  });

  test('should create schema_version table', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);
    await manager.runMigrations();

    // schema_version table must exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get();

    expect(tables).toBeDefined();
    expect(tables.name).toBe('schema_version');

    db.close();
  });

  test('should track schema version correctly', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);
    await manager.runMigrations();

    const version = manager.getCurrentVersion();
    // Version should be >= 1 after running migrations
    expect(version).toBeGreaterThanOrEqual(1);

    db.close();
  });

  test('should be idempotent - running twice should not fail', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);

    await manager.runMigrations();
    const version1 = manager.getCurrentVersion();

    await manager.runMigrations();
    const version2 = manager.getCurrentVersion();

    expect(version1).toBe(version2);

    db.close();
  });

  test('should apply migrations in order', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);

    // Manually apply a test migration
    await manager.applyMigration(1, 'Test migration', (db) => {
      db.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY)');
    });

    const version = manager.getCurrentVersion();
    expect(version).toBe(1);

    // Verify the migration was recorded
    const record = db.prepare('SELECT * FROM schema_version WHERE version = 1').get();
    expect(record).toBeDefined();
    expect(record.description).toBe('Test migration');

    db.close();
  });

  test('should skip already-applied migrations', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);

    // Apply migration 1
    const applied1 = await manager.applyMigration(1, 'First migration', (db) => {
      db.exec('CREATE TABLE first_table (id INTEGER PRIMARY KEY)');
    });
    expect(applied1).toBe(true);

    // Try to apply migration 1 again - should be skipped
    const applied2 = await manager.applyMigration(1, 'First migration', (db) => {
      db.exec('CREATE TABLE first_table (id INTEGER PRIMARY KEY)');
    });
    expect(applied2).toBe(false);

    db.close();
  });

  test('legacy tables should not exist in fresh database', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);
    await manager.runMigrations();

    // These legacy tables should NOT exist in a fresh database
    const legacyTables = [
      'todoist_sync_mapping',
      'markdown_sync',
      'cache_metadata',
    ];

    for (const tableName of legacyTables) {
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(tableName);
      expect(table).toBeUndefined();
    }

    db.close();
  });
});
