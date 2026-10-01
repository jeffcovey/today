import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

// db-health.js resolves `.data/today.db` against the working directory, so each
// test runs in its own temp directory. better-sqlite3 is wrapped so a test can
// make the driver throw the way it does when it can't load or open the file.
const RealDatabase = (await import('better-sqlite3')).default;

let driverError = null;
jest.unstable_mockModule('better-sqlite3', () => ({
  default: function Database(...args) {
    if (driverError) throw driverError;
    return new RealDatabase(...args);
  }
}));

const {
  checkDatabaseHealth,
  createFreshDatabase,
  ensureHealthyDatabase,
} = await import('../src/db-health.js');

const DB = '.data/today.db';

function bindingError() {
  return new Error(
    'Could not locate the bindings file. Tried:\n' +
    ' → /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  );
}

function sqliteError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Create a healthy database holding one row we can look for afterwards. */
async function seedDatabase() {
  expect(await createFreshDatabase()).toBe(true);
  const db = new RealDatabase(DB);
  db.exec("CREATE TABLE canary (note TEXT); INSERT INTO canary VALUES ('still here')");
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

function canary() {
  const db = new RealDatabase(DB, { readonly: true });
  try {
    return db.prepare('SELECT note FROM canary').get()?.note;
  } finally {
    db.close();
  }
}

function hasTable(name) {
  const db = new RealDatabase(DB, { readonly: true });
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } finally {
    db.close();
  }
}

function dataFiles() {
  return fs.existsSync('.data') ? fs.readdirSync('.data').sort() : [];
}

function stagingFiles() {
  return dataFiles().filter(f => f.includes('.new-'));
}

describe('db-health', () => {
  let originalCwd;
  let tempDir;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-db-health-'));
    process.chdir(tempDir);
    driverError = null;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('when the driver cannot load', () => {
    test('checkDatabaseHealth reports the database as unavailable, not corrupted', async () => {
      await seedDatabase();
      driverError = bindingError();

      const health = checkDatabaseHealth();

      expect(health.healthy).toBe(false);
      expect(health.unavailable).toBe(true);
      expect(health.driverError).toBe(true);
      expect(health.corrupted).toBeUndefined();
      expect(health.reason).toContain('Could not locate the bindings file');
    });

    test('ensureHealthyDatabase fails without touching the database', async () => {
      await seedDatabase();
      const before = fs.readFileSync(DB);
      driverError = bindingError();

      const result = await ensureHealthyDatabase({ verbose: true });

      expect(result.success).toBe(false);
      expect(result.recreated).toBe(false);
      expect(result.message).toContain('Could not locate the bindings file');
      expect(fs.readFileSync(DB).equals(before)).toBe(true);
      // No backup either: nothing was about to be replaced
      expect(dataFiles().filter(f => f.includes('backup'))).toEqual([]);

      const printed = console.log.mock.calls.flat().join('\n');
      expect(printed).toContain('npm rebuild better-sqlite3');

      driverError = null;
      expect(canary()).toBe('still here');
    });

    test('createFreshDatabase keeps the existing database when it cannot build a new one', async () => {
      await seedDatabase();
      driverError = bindingError();

      expect(await createFreshDatabase()).toBe(false);

      driverError = null;
      expect(canary()).toBe('still here');
      expect(stagingFiles()).toEqual([]);
    });

    test('forceRecreate still cannot destroy the database', async () => {
      await seedDatabase();
      driverError = bindingError();

      const result = await ensureHealthyDatabase({ verbose: false, forceRecreate: true });

      expect(result.success).toBe(false);
      driverError = null;
      expect(canary()).toBe('still here');
    });
  });

  describe('when SQLite reports a non-corruption error', () => {
    test.each([
      ['SQLITE_BUSY', 'database is locked'],
      ['SQLITE_CANTOPEN', 'unable to open database file'],
    ])('%s leaves the database alone', async (code, message) => {
      await seedDatabase();
      driverError = sqliteError(code, message);

      const health = checkDatabaseHealth();
      expect(health).toMatchObject({ healthy: false, unavailable: true, driverError: false });

      const result = await ensureHealthyDatabase({ verbose: true });
      expect(result.success).toBe(false);
      expect(result.recreated).toBe(false);
      // The rebuild hint is only for a driver that failed to load
      expect(console.log.mock.calls.flat().join('\n')).not.toContain('npm rebuild');

      driverError = null;
      expect(canary()).toBe('still here');
    });
  });

  describe('when the database really is unusable', () => {
    test('a missing database is created', async () => {
      const result = await ensureHealthyDatabase({ verbose: false });

      expect(result).toMatchObject({ success: true, recreated: true });
      expect(checkDatabaseHealth().healthy).toBe(true);
    });

    test('a corrupted database is recreated', async () => {
      fs.mkdirSync('.data');
      fs.writeFileSync(DB, 'this is not a sqlite database '.repeat(200));

      expect(checkDatabaseHealth()).toMatchObject({ healthy: false, corrupted: true });

      const result = await ensureHealthyDatabase({ verbose: false });

      expect(result).toMatchObject({ success: true, recreated: true });
      expect(checkDatabaseHealth().healthy).toBe(true);
    });

    test('a database without schema_version is backed up and recreated', async () => {
      fs.mkdirSync('.data');
      const db = new RealDatabase(DB);
      db.exec("CREATE TABLE canary (note TEXT); INSERT INTO canary VALUES ('old')");
      db.close();

      const result = await ensureHealthyDatabase({ verbose: false });

      expect(result).toMatchObject({ success: true, recreated: true });
      expect(hasTable('canary')).toBe(false);
      expect(hasTable('schema_version')).toBe(true);
      expect(fs.existsSync('.data/today.db.backup')).toBe(true);
    });
  });

  test('createFreshDatabase replaces an existing database and leaves no staging files', async () => {
    await seedDatabase();

    expect(await createFreshDatabase()).toBe(true);

    expect(hasTable('canary')).toBe(false);
    expect(hasTable('schema_version')).toBe(true);
    expect(stagingFiles()).toEqual([]);
  });
});
