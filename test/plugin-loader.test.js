import { jest } from '@jest/globals';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock the config module
jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn().mockReturnValue({}),
  getConfig: jest.fn(),
  getApiModel: jest.fn().mockReturnValue('claude-sonnet-4-20250514'),
  getInteractiveModel: jest.fn().mockReturnValue('sonnet'),
  getTimezone: jest.fn().mockReturnValue('America/New_York'),
  getClaudeModel: jest.fn().mockReturnValue('claude-sonnet-4-20250514'),
  getVaultPath: jest.fn().mockReturnValue('vault'),
  getAbsoluteVaultPath: jest.fn().mockReturnValue('/tmp/test-vault'),
  getConfigPath: jest.fn().mockReturnValue('config.toml'),
}));

// Import after mocking
const { getFullConfig } = await import('../src/config.js');
const {
  discoverPlugins,
  getPluginSources,
  getEnabledPlugins,
  getPluginAccess,
  tryAcquireSyncLock,
  releaseSyncLock,
  refreshSyncLock,
  startSyncLockHeartbeat,
  syncPluginSource
} = await import('../src/plugin-loader.js');
const { getSqlColumns } = await import('../src/plugin-schemas.js');
const Database = (await import('better-sqlite3')).default;

function makeLockDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sync_metadata (
      source TEXT PRIMARY KEY,
      sync_locked_at TEXT,
      sync_locked_by TEXT,
      last_synced_at TEXT,
      last_sync_files TEXT,
      entries_count INTEGER,
      extra_data TEXT
    )
  `);
  return db;
}

describe('Plugin Loader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('discoverPlugins', () => {
    test('should discover markdown-time-tracking plugin from plugins directory', async () => {
      const plugins = await discoverPlugins();

      expect(plugins.size).toBeGreaterThan(0);
      expect(plugins.has('markdown-time-tracking')).toBe(true);
    });

    test('should return plugin metadata from plugin.toml', async () => {
      const plugins = await discoverPlugins();
      const timeTracking = plugins.get('markdown-time-tracking');

      expect(timeTracking).toHaveProperty('name', 'markdown-time-tracking');
      expect(timeTracking).toHaveProperty('displayName', 'Markdown Time Tracking');
      expect(timeTracking).toHaveProperty('type', 'time-logs');
      expect(timeTracking).toHaveProperty('commands');
      expect(timeTracking.commands).toHaveProperty('read');
      expect(timeTracking.commands).toHaveProperty('write');
    });

    test('should derive access from commands via getPluginAccess', async () => {
      const plugins = await discoverPlugins();
      const timeTracking = plugins.get('markdown-time-tracking');
      const dayoneDiary = plugins.get('dayone-diary');

      // markdown-time-tracking has both read and write
      expect(getPluginAccess(timeTracking)).toBe('read-write');

      // dayone-diary has only read
      expect(getPluginAccess(dayoneDiary)).toBe('read-only');
    });

    test('should include plugin path in metadata', async () => {
      const plugins = await discoverPlugins();
      const timeTracking = plugins.get('markdown-time-tracking');

      expect(timeTracking).toHaveProperty('_path');
      expect(timeTracking._path).toContain('markdown-time-tracking');
    });
  });

  describe('getPluginSources', () => {
    test('should return empty array when plugin not configured', () => {
      getFullConfig.mockReturnValue({});

      const sources = getPluginSources('markdown-time-tracking');

      expect(sources).toEqual([]);
    });

    test('should return empty array when no plugins section', () => {
      getFullConfig.mockReturnValue({ timezone: 'America/New_York' });

      const sources = getPluginSources('markdown-time-tracking');

      expect(sources).toEqual([]);
    });

    test('should return sources with enabled = true', () => {
      getFullConfig.mockReturnValue({
        plugins: {
          'markdown-time-tracking': {
            local: { enabled: true, days_to_sync: 365 },
            work: { enabled: true, directory: 'vault/logs/work' }
          }
        }
      });

      const sources = getPluginSources('markdown-time-tracking');

      expect(sources).toHaveLength(2);
      expect(sources[0]).toEqual({
        sourceName: 'local',
        config: { enabled: true, days_to_sync: 365 }
      });
      expect(sources[1]).toEqual({
        sourceName: 'work',
        config: { enabled: true, directory: 'vault/logs/work' }
      });
    });

    test('should exclude sources with enabled = false', () => {
      getFullConfig.mockReturnValue({
        plugins: {
          'markdown-time-tracking': {
            local: { enabled: true },
            disabled: { enabled: false }
          }
        }
      });

      const sources = getPluginSources('markdown-time-tracking');

      expect(sources).toHaveLength(1);
      expect(sources[0].sourceName).toBe('local');
    });

    test('should exclude sources without enabled = true (opt-in)', () => {
      getFullConfig.mockReturnValue({
        plugins: {
          'markdown-time-tracking': {
            local: { enabled: true },
            implicit: { days_to_sync: 30 }  // no enabled field
          }
        }
      });

      const sources = getPluginSources('markdown-time-tracking');

      expect(sources).toHaveLength(1);
      expect(sources[0].sourceName).toBe('local');
    });
  });

  describe('sync lock', () => {
    test('tryAcquireSyncLock succeeds on an unlocked source and blocks a second caller', () => {
      const db = makeLockDb();
      expect(tryAcquireSyncLock(db, 'plugin/source', 'a:1')).toBe(true);
      expect(tryAcquireSyncLock(db, 'plugin/source', 'b:2')).toBe(false);
    });

    test('releaseSyncLock only releases when lockedBy matches', () => {
      const db = makeLockDb();
      tryAcquireSyncLock(db, 'plugin/source', 'a:1');

      // Wrong owner cannot release
      releaseSyncLock(db, 'plugin/source', 'b:2');
      expect(tryAcquireSyncLock(db, 'plugin/source', 'b:2')).toBe(false);

      // Correct owner releases
      releaseSyncLock(db, 'plugin/source', 'a:1');
      expect(tryAcquireSyncLock(db, 'plugin/source', 'b:2')).toBe(true);
    });

    test('a lock older than the stale window is reclaimable (baseline behavior)', () => {
      const db = makeLockDb();
      tryAcquireSyncLock(db, 'plugin/source', 'a:1');
      // Simulate the holder having been "stuck" for longer than the 5-minute stale window
      db.prepare(`UPDATE sync_metadata SET sync_locked_at = datetime('now', '-6 minutes')`).run();

      expect(tryAcquireSyncLock(db, 'plugin/source', 'b:2')).toBe(true);
    });

    test('refreshSyncLock pushes the timestamp forward so a stale lock is no longer reclaimable', () => {
      const db = makeLockDb();
      tryAcquireSyncLock(db, 'plugin/source', 'a:1');
      db.prepare(`UPDATE sync_metadata SET sync_locked_at = datetime('now', '-6 minutes')`).run();

      refreshSyncLock(db, 'plugin/source', 'a:1');

      expect(tryAcquireSyncLock(db, 'plugin/source', 'b:2')).toBe(false);
    });

    test('refreshSyncLock is a no-op for a non-owner (prevents stealing)', () => {
      const db = makeLockDb();
      tryAcquireSyncLock(db, 'plugin/source', 'a:1');
      db.prepare(`UPDATE sync_metadata SET sync_locked_at = datetime('now', '-6 minutes')`).run();

      refreshSyncLock(db, 'plugin/source', 'b:2');

      // The lock is still stale (b:2's refresh did nothing), so a third caller can reclaim
      expect(tryAcquireSyncLock(db, 'plugin/source', 'c:3')).toBe(true);
    });

    test('startSyncLockHeartbeat fires refreshSyncLock on the configured interval and stops cleanly', () => {
      jest.useFakeTimers();
      try {
        const db = makeLockDb();
        tryAcquireSyncLock(db, 'plugin/source', 'a:1');

        const handle = startSyncLockHeartbeat(db, 'plugin/source', 'a:1');

        // Stale the timestamp, then let the heartbeat fire
        db.prepare(`UPDATE sync_metadata SET sync_locked_at = datetime('now', '-6 minutes')`).run();
        jest.advanceTimersByTime(60_000);

        // Heartbeat refreshed the lock — another caller cannot acquire
        expect(tryAcquireSyncLock(db, 'plugin/source', 'b:2')).toBe(false);

        handle.stop();
        // After stop(), advancing time does not cause further refreshes
        db.prepare(`UPDATE sync_metadata SET sync_locked_at = datetime('now', '-6 minutes')`).run();
        jest.advanceTimersByTime(120_000);

        // Lock is stale again, so it IS reclaimable
        expect(tryAcquireSyncLock(db, 'plugin/source', 'b:2')).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('getEnabledPlugins', () => {
    test('should return empty array when no plugins configured', async () => {
      getFullConfig.mockReturnValue({});

      const enabled = await getEnabledPlugins();

      expect(enabled).toEqual([]);
    });

    test('should return plugins with their sources', async () => {
      getFullConfig.mockReturnValue({
        plugins: {
          'markdown-time-tracking': {
            local: { enabled: true, days_to_sync: 365 }
          }
        }
      });

      const enabled = await getEnabledPlugins();

      expect(enabled).toHaveLength(1);
      expect(enabled[0].plugin.name).toBe('markdown-time-tracking');
      expect(enabled[0].sources).toHaveLength(1);
      expect(enabled[0].sources[0].sourceName).toBe('local');
    });
  });

  // Regression for #325: deleting a markdown file must remove its task rows.
  // A deleted file is present in the targeted-sync fileFilter but never in the
  // plugin's files_processed (the plugin skips paths that no longer exist), so
  // before the fix its rows were orphaned and kept showing in the task timer.
  describe('deleted-file reconciliation (targeted sync)', () => {
    let pluginDir;
    let plugin;

    beforeAll(() => {
      // Stub 'read' command: files whose path contains "exists" are treated as
      // present (returned with a task + listed in files_processed); every other
      // filtered file is treated as deleted (skipped, mirroring fs.existsSync).
      pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-stub-'));
      const readPath = path.join(pluginDir, 'read.js');
      fs.writeFileSync(readPath, `#!/usr/bin/env node
const filter = (process.env.FILE_FILTER || '').split(',').map(s => s.trim()).filter(Boolean);
const entries = [];
const files_processed = [];
for (const f of filter) {
  if (f.includes('exists')) {
    files_processed.push(f);
    entries.push({ id: f + ':1', title: 'kept task', status: 'open' });
  }
}
console.log(JSON.stringify({ entries, files_processed, incremental: true }));
`);
      fs.chmodSync(readPath, 0o755);
      plugin = {
        name: 'tasks-stub',
        type: 'tasks',
        _path: pluginDir,
        commands: { read: 'read.js' }
      };
    });

    afterAll(() => {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    function makeTasksDb() {
      const db = new Database(':memory:');
      db.exec(`CREATE TABLE tasks (${getSqlColumns('tasks')})`);
      db.exec(`
        CREATE TABLE sync_metadata (
          source TEXT PRIMARY KEY,
          sync_locked_at TEXT,
          sync_locked_by TEXT,
          last_synced_at TEXT,
          last_sync_files TEXT,
          entries_count INTEGER,
          extra_data TEXT
        )
      `);
      return db;
    }

    const sourceId = 'tasks-stub/default';
    const insertTask = (db, id, title) =>
      db.prepare(`INSERT INTO tasks (id, source, title, status) VALUES (?, ?, ?, 'open')`)
        .run(`${sourceId}:${id}`, sourceId, title);
    const ids = (db) => db.prepare(`SELECT id FROM tasks ORDER BY id`).all().map(r => r.id);

    test('removes rows for a deleted file while preserving unfiltered and updating existing files', async () => {
      const db = makeTasksDb();
      insertTask(db, 'vault/deleted.md:20', 'orphan');     // in filter, file gone -> delete
      insertTask(db, 'vault/exists.md:1', 'old title');    // in filter, file present -> update
      insertTask(db, 'vault/untouched.md:5', 'safe');      // not in filter -> keep

      const result = await syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, {
        fileFilter: 'vault/deleted.md,vault/exists.md',
        _caller: 'test'
      });

      expect(result.success).toBe(true);
      expect(ids(db)).toEqual([
        `${sourceId}:vault/exists.md:1`,
        `${sourceId}:vault/untouched.md:5`
      ]);
      expect(
        db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(`${sourceId}:vault/exists.md:1`).title
      ).toBe('kept task');
    });

    test('reconciles a pure deletion (no entries returned) past the empty-incremental short-circuit', async () => {
      const db = makeTasksDb();
      insertTask(db, 'vault/deleted.md:20', 'orphan');
      db.prepare(
        `INSERT INTO sync_metadata (source, last_synced_at, last_sync_files, entries_count) VALUES (?, datetime('now'), '[]', 1)`
      ).run(sourceId);

      const result = await syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, {
        fileFilter: 'vault/deleted.md',
        _caller: 'test'
      });

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/Removed 1 row/);
      expect(ids(db)).toEqual([]);
      expect(
        db.prepare(`SELECT entries_count FROM sync_metadata WHERE source = ?`).get(sourceId).entries_count
      ).toBe(0);
    });

    test('escapes LIKE wildcards so an underscore filename cannot delete unrelated rows', async () => {
      const db = makeTasksDb();
      insertTask(db, 'vault/a_b.md:1', 'underscore file');  // deleted target
      insertTask(db, 'vault/axb.md:1', 'lookalike');        // must NOT be deleted

      await syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, {
        fileFilter: 'vault/a_b.md',
        _caller: 'test'
      });

      expect(ids(db)).toEqual([`${sourceId}:vault/axb.md:1`]);
    });
  });

  describe('data.error surfacing', () => {
    let pluginDir;
    let plugin;

    beforeAll(() => {
      pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-stub-'));
      const readPath = path.join(pluginDir, 'read.js');
      fs.writeFileSync(readPath, `#!/usr/bin/env node
console.log(JSON.stringify({ entries: [], files_processed: [], incremental: false, error: 'simulated plugin error' }));
`);
      fs.chmodSync(readPath, 0o755);
      plugin = {
        name: 'error-stub',
        type: 'tasks',
        _path: pluginDir,
        commands: { read: 'read.js' }
      };
    });

    describe('metadata warning surfacing', () => {
      let pluginDir;
      let plugin;

      beforeAll(() => {
        pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warning-stub-'));
        const readPath = path.join(pluginDir, 'read.js');
        fs.writeFileSync(readPath, `#!/usr/bin/env node
console.log(JSON.stringify({
    entries: [],
    files_processed: [],
    incremental: true,
    metadata: { warnings: ['simulated warning'] }
}));
`);
        fs.chmodSync(readPath, 0o755);
        plugin = {
          name: 'warning-stub',
          type: 'tasks',
          _path: pluginDir,
          commands: { read: 'read.js' }
        };
      });

      afterAll(() => {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      });

      test('includes plugin warnings in successful sync messages', async () => {
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE tasks (${getSqlColumns('tasks')})`);
        db.exec(`CREATE TABLE sync_metadata (source TEXT PRIMARY KEY, sync_locked_at TEXT, sync_locked_by TEXT, last_synced_at TEXT, last_sync_files TEXT, entries_count INTEGER, extra_data TEXT)`);

        const result = await syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, {});

        expect(result.success).toBe(true);
        expect(result.message).toContain('simulated warning');
      });

      test('includes plugin message and hint in empty incremental sync messages', async () => {
        const readPath = path.join(pluginDir, 'read.js');
        fs.writeFileSync(readPath, `#!/usr/bin/env node
console.log(JSON.stringify({
    entries: [],
    files_processed: [],
    incremental: true,
    metadata: {
      message: 'No YNAB budgets to sync',
      hint: 'All budgets were filtered out',
      warnings: ['simulated warning']
    }
}));
`);
        fs.chmodSync(readPath, 0o755);

        const db = new Database(':memory:');
        db.exec(`CREATE TABLE tasks (${getSqlColumns('tasks')})`);
        db.exec(`CREATE TABLE sync_metadata (source TEXT PRIMARY KEY, sync_locked_at TEXT, sync_locked_by TEXT, last_synced_at TEXT, last_sync_files TEXT, entries_count INTEGER, extra_data TEXT)`);

        const result = await syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, {});

        expect(result.success).toBe(true);
        expect(result.message).toContain('No YNAB budgets to sync');
        expect(result.message).toContain('All budgets were filtered out');
        expect(result.message).toContain('simulated warning');
      });

      test('refreshes entries_count when a plugin reports rows_purged on an empty incremental sync', async () => {
        const readPath = path.join(pluginDir, 'read.js');
        fs.writeFileSync(readPath, `#!/usr/bin/env node
console.log(JSON.stringify({
    entries: [],
    files_processed: [],
    incremental: true,
    metadata: {
      rows_purged: 2
    }
}));
`);
        fs.chmodSync(readPath, 0o755);

        const db = new Database(':memory:');
        db.exec(`CREATE TABLE tasks (${getSqlColumns('tasks')})`);
        db.exec(`CREATE TABLE sync_metadata (source TEXT PRIMARY KEY, sync_locked_at TEXT, sync_locked_by TEXT, last_synced_at TEXT, last_sync_files TEXT, entries_count INTEGER, extra_data TEXT)`);
        const sourceId = 'warning-stub/default';
        db.prepare(`INSERT INTO tasks (id, source, title, status) VALUES (?, ?, ?, 'open')`)
          .run(`${sourceId}:1`, sourceId, 'kept task');
        db.prepare(`INSERT INTO sync_metadata (source, last_synced_at, last_sync_files, entries_count) VALUES (?, datetime('now'), '[]', 3)`)
          .run(sourceId);

        const result = await syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, {});

        expect(result.success).toBe(true);
        expect(result.message).toContain('Removed 2 row(s) for plugin-managed deletions');
        expect(
          db.prepare(`SELECT entries_count FROM sync_metadata WHERE source = ?`).get(sourceId).entries_count
        ).toBe(1);
      });
    });

    afterAll(() => {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    test('returns success:false when plugin exits 0 but reports data.error', async () => {
      const db = new Database(':memory:');
      db.exec(`CREATE TABLE tasks (${getSqlColumns('tasks')})`);
      db.exec(`CREATE TABLE sync_metadata (source TEXT PRIMARY KEY, sync_locked_at TEXT, sync_locked_by TEXT, last_synced_at TEXT, last_sync_files TEXT, entries_count INTEGER, extra_data TEXT)`);

      const result = await syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, {});

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/simulated plugin error/);
    });
  });

  describe('insertEntries atomicity', () => {
    // Verifies that the delete and the inserts happen inside a single transaction
    // so a concurrent reader never sees an empty table between the two operations.
    // We prove atomicity by making the INSERT fail mid-way with a SQLite trigger
    // and asserting that the pre-existing rows survive (rolled back with the delete).

    let pluginDir;
    let plugin;

    beforeAll(() => {
      pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-stub-'));
      const readPath = path.join(pluginDir, 'read.js');
      // Returns two entries from one file (incremental, file-based delete path)
      fs.writeFileSync(readPath, `#!/usr/bin/env node
console.log(JSON.stringify({
  entries: [
    { id: 'vault/file.md:1', title: 'new task 1', status: 'open' },
    { id: 'vault/file.md:2', title: 'new task 2', status: 'open' }
  ],
  files_processed: ['vault/file.md'],
  incremental: true
}));
`);
      fs.chmodSync(readPath, 0o755);
      plugin = {
        name: 'atomic-stub',
        type: 'tasks',
        _path: pluginDir,
        commands: { read: 'read.js' }
      };
    });

    afterAll(() => {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    function makeDb() {
      const db = new Database(':memory:');
      db.exec(`CREATE TABLE tasks (${getSqlColumns('tasks')})`);
      db.exec(`CREATE TABLE sync_metadata (source TEXT PRIMARY KEY, sync_locked_at TEXT, sync_locked_by TEXT, last_synced_at TEXT, last_sync_files TEXT, entries_count INTEGER, extra_data TEXT)`);
      return db;
    }

    test('pre-existing tasks survive when an error aborts the insert mid-transaction', async () => {
      const sourceId = 'atomic-stub/default';
      const db = makeDb();

      // Seed a task from the file that will be re-synced
      db.prepare(`INSERT INTO tasks (id, source, title, status) VALUES (?, ?, ?, 'open')`)
        .run(`${sourceId}:vault/file.md:1`, sourceId, 'pre-existing task');

      // Install a trigger that aborts on the second INSERT into tasks, simulating
      // a crash that occurs after the delete but before all inserts complete.
      db.exec(`
        CREATE TEMP TABLE _insert_count (n INTEGER DEFAULT 0);
        INSERT INTO _insert_count VALUES (0);
        CREATE TEMP TRIGGER abort_second_insert BEFORE INSERT ON tasks
        BEGIN
          UPDATE _insert_count SET n = n + 1;
          SELECT CASE WHEN (SELECT n FROM _insert_count) >= 2
            THEN RAISE(ABORT, 'simulated mid-insert failure')
          END;
        END;
      `);

      // Sync will throw because the trigger aborts the second insert
      await expect(
        syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, { _caller: 'test' })
      ).rejects.toThrow('simulated mid-insert failure');

      // The pre-existing task must still be present — the delete was rolled back
      // with the failed insert because both ran inside the same transaction.
      const rows = db.prepare(`SELECT id FROM tasks WHERE source = ?`).all(sourceId);
      expect(rows.map(r => r.id)).toContain(`${sourceId}:vault/file.md:1`);
    });

    test('full-source delete is also atomic with the inserts', async () => {
      const sourceId = 'atomic-stub/default';
      const db = makeDb();

      // Seed tasks from a *different* file so a file-filtered sync won't touch them,
      // but a full sync (filesProcessed: null) would delete everything first.
      db.prepare(`INSERT INTO tasks (id, source, title, status) VALUES (?, ?, ?, 'open')`)
        .run(`${sourceId}:vault/other.md:1`, sourceId, 'unrelated task');

      // Use a full-sync plugin (no files_processed) so the full-source delete path runs
      const fullPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-full-stub-'));
      const fullReadPath = path.join(fullPluginDir, 'read.js');
      fs.writeFileSync(fullReadPath, `#!/usr/bin/env node
console.log(JSON.stringify({
  entries: [
    { id: 'vault/file.md:1', title: 'new task 1', status: 'open' },
    { id: 'vault/file.md:2', title: 'new task 2', status: 'open' }
  ]
}));
`);
      fs.chmodSync(fullReadPath, 0o755);
      const fullPlugin = { name: 'atomic-stub', type: 'tasks', _path: fullPluginDir, commands: { read: 'read.js' } };

      db.exec(`
        CREATE TEMP TABLE _insert_count2 (n INTEGER DEFAULT 0);
        INSERT INTO _insert_count2 VALUES (0);
        CREATE TEMP TRIGGER abort_second_insert2 BEFORE INSERT ON tasks
        BEGIN
          UPDATE _insert_count2 SET n = n + 1;
          SELECT CASE WHEN (SELECT n FROM _insert_count2) >= 2
            THEN RAISE(ABORT, 'simulated mid-insert failure')
          END;
        END;
      `);

      await expect(
        syncPluginSource(fullPlugin, 'default', {}, { db, vaultPath: 'vault' }, { _caller: 'test' })
      ).rejects.toThrow('simulated mid-insert failure');

      // The unrelated task must survive — the full-source delete was rolled back
      const rows = db.prepare(`SELECT id FROM tasks WHERE source = ?`).all(sourceId);
      expect(rows.map(r => r.id)).toContain(`${sourceId}:vault/other.md:1`);

      fs.rmSync(fullPluginDir, { recursive: true, force: true });
    });
  });

  describe('finance reconciliation timing', () => {
    let pluginDir;
    let plugin;

    beforeAll(() => {
      pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-stub-'));
      const readPath = path.join(pluginDir, 'read.js');
      fs.writeFileSync(readPath, `#!/usr/bin/env node
console.log(JSON.stringify({
  entries: [{
    id: 'csv-1',
    date: '2026-05-01',
    account: 'Checking',
    payee: 'Disney+',
    amount: -14.93,
    metadata: JSON.stringify({ source_file: 'Household as of 2026-05-02 12-00 - Register.csv' })
  }],
  files_processed: ['vault/logs/Household as of 2026-05-02 12-00 - Register.csv'],
  incremental: true
}));
`);
      fs.chmodSync(readPath, 0o755);
      plugin = {
        name: 'ynab-finance',
        type: 'finance',
        _path: pluginDir,
        commands: { read: 'read.js' }
      };
    });

    afterAll(() => {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    test('new finance rows are reconciled after insert in the same sync', async () => {
      const db = new Database(':memory:');
      db.exec(`CREATE TABLE financial_transactions (${getSqlColumns('finance')})`);
      db.exec(`CREATE TABLE sync_metadata (source TEXT PRIMARY KEY, sync_locked_at TEXT, sync_locked_by TEXT, last_synced_at TEXT, last_sync_files TEXT, entries_count INTEGER, extra_data TEXT)`);
      db.prepare(`INSERT INTO financial_transactions
        (id, source, date, account, payee, amount, scheduled, metadata)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
        .run(
          'api-1',
          'ynab-api/personal',
          '2026-05-01',
          'Checking',
          'Disney+',
          -14.93,
          JSON.stringify({ budget_name: 'Household' })
        );

      const result = await syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, { _caller: 'test' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Superseded 1 duplicate row');
      expect(
        db.prepare(`SELECT superseded_by FROM financial_transactions WHERE source = 'ynab-finance/default'`).get().superseded_by
      ).toBe('api-1');
    });
  });
});
