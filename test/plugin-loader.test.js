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

      const result = await syncPluginSource(plugin, 'default', {}, { db, vaultPath: 'vault' }, {
        fileFilter: 'vault/deleted.md',
        _caller: 'test'
      });

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/Removed 1 row/);
      expect(ids(db)).toEqual([]);
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
});
