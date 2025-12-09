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

  test('should create database from scratch with all migrations', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);

    const version = await manager.runMigrations();

    // Should have applied all migrations
    expect(version).toBeGreaterThanOrEqual(33);

    db.close();
  });

  test('should create all required tables', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);
    await manager.runMigrations();

    // Get all tables
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(row => row.name);

    // Core tables that must exist
    const requiredTables = [
      'markdown_tasks',
      'time_entries',
      'calendar_events',
      'contacts',
      'emails',
      'diary',
      'sync_log',
      'schema_version'
    ];

    for (const table of requiredTables) {
      expect(tables).toContain(table);
    }

    db.close();
  });

  test('markdown_tasks table should have correct schema', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);
    await manager.runMigrations();

    const columns = db.prepare('PRAGMA table_info(markdown_tasks)').all();
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('file_path');
    expect(columnNames).toContain('line_number');
    expect(columnNames).toContain('line_text');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('updated_at');

    db.close();
  });

  test('time_entries table should have correct schema', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);
    await manager.runMigrations();

    const columns = db.prepare('PRAGMA table_info(time_entries)').all();
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('start_time');
    expect(columnNames).toContain('end_time');
    expect(columnNames).toContain('description');
    expect(columnNames).toContain('topics');
    expect(columnNames).toContain('source');

    db.close();
  });

  test('contacts table should have last_contacted column', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);
    await manager.runMigrations();

    const columns = db.prepare('PRAGMA table_info(contacts)').all();
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('last_contacted');
    expect(columnNames).toContain('notes');

    db.close();
  });

  test('should be idempotent - running twice should not fail', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);

    const version1 = await manager.runMigrations();
    const version2 = await manager.runMigrations();

    expect(version1).toBe(version2);

    db.close();
  });

  test('legacy tasks table should not exist', async () => {
    const db = new Database(dbPath);
    const manager = new MigrationManager(db);
    await manager.runMigrations();

    // The old 'tasks' table was dropped in migration 29
    const tasksTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).get();

    expect(tasksTable).toBeUndefined();

    db.close();
  });
});
