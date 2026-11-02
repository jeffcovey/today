import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Per-source staleness: each enabled source of a type is judged by its own
// sync_metadata row, so a fresh source doesn't hide a stale one, and a read
// sync only syncs the sources that are due.

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const pluginDir = path.join(repoRoot, 'plugins', 'per-source-staleness-stub');
const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'per-source-staleness-')), 'reads.log');
// While this file exists, the stub reports a successful read with no changes.
const noChange = path.join(path.dirname(marker), 'no-change');

fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'plugin.toml'), `
name = "per-source-staleness-stub"
displayName = "Per-Source Staleness Stub"
description = "Stub plugin for per-source staleness tests"
type = "tasks"
access = "read-only"

[commands]
read = "./read.js"
`);
fs.writeFileSync(path.join(pluginDir, 'read.js'), `#!/usr/bin/env node
import fs from 'fs';
fs.appendFileSync(${JSON.stringify(marker)}, process.env.SOURCE_ID + '\\n');
if (fs.existsSync(${JSON.stringify(noChange)})) {
  const metadata = JSON.parse(fs.readFileSync(${JSON.stringify(noChange)}, 'utf8') || '{}');
  console.log(JSON.stringify({ entries: [], files_processed: [], incremental: true, metadata }));
  process.exit(0);
}
console.log(JSON.stringify({ entries: [{ id: process.env.SOURCE_ID + ':1', title: 'A task', status: 'open' }] }));
`);
fs.chmodSync(path.join(pluginDir, 'read.js'), 0o755);

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn().mockReturnValue({
    plugins: {
      'per-source-staleness-stub': {
        a: { enabled: true },
        b: { enabled: true },
        off: { enabled: false },
      },
    },
  }),
  getConfig: jest.fn(),
  getApiModel: jest.fn().mockReturnValue('claude-sonnet-4-20250514'),
  getInteractiveModel: jest.fn().mockReturnValue('sonnet'),
  getTimezone: jest.fn().mockReturnValue('America/New_York'),
  getClaudeModel: jest.fn().mockReturnValue('claude-sonnet-4-20250514'),
  getVaultPath: jest.fn().mockReturnValue('vault'),
  getAbsoluteVaultPath: jest.fn().mockReturnValue('/tmp/test-vault'),
  getConfigPath: jest.fn().mockReturnValue('config.toml'),
}));

const {
  ensureSyncForType, readSyncNeeded, getStaleSourcesForType, getOldestSyncTimeForType, getSyncStatusMessage,
  getReadSourcesForType, syncPluginSource,
} = await import('../src/plugin-loader.js');
const { getSqlColumns, getStaleMinutes } = await import('../src/plugin-schemas.js');
const Database = (await import('better-sqlite3')).default;

const A = 'per-source-staleness-stub/a';
const B = 'per-source-staleness-stub/b';

function createDb() {
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

/** Record a source as last synced `minutesAgo` minutes ago (null: a row with no sync time). */
function synced(db, source, minutesAgo) {
  db.prepare(`INSERT INTO sync_metadata (source, last_synced_at) VALUES (?, ${minutesAgo === null ? 'NULL' : `datetime('now', '-${minutesAgo} minutes')`})`).run(source);
}

const reads = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).sort() : []);

describe('per-source staleness', () => {
  const staleMinutes = getStaleMinutes('tasks');
  const contextOnly = process.env.CONTEXT_ONLY;

  beforeAll(() => {
    expect(staleMinutes).toBeGreaterThan(1);
    delete process.env.CONTEXT_ONLY;
  });
  afterAll(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
    if (contextOnly !== undefined) process.env.CONTEXT_ONLY = contextOnly;
  });
  beforeEach(() => {
    fs.rmSync(marker, { force: true });
    fs.rmSync(noChange, { force: true });
  });
  afterEach(() => { delete process.env.CONTEXT_ONLY; });

  test('a fresh source and a stale one: only the stale one syncs', async () => {
    const db = createDb();
    synced(db, A, 0);
    synced(db, B, staleMinutes + 60);
    expect(readSyncNeeded(db, 'tasks')).toBe(true);
    expect(getStaleSourcesForType(db, 'tasks').map(s => s.sourceId)).toEqual([B]);

    expect(await ensureSyncForType(db, 'tasks')).toBe(true);
    expect(reads()).toEqual([B]);
    expect(readSyncNeeded(db, 'tasks')).toBe(false);
  });

  test('a source with no sync_metadata row, or no sync time in it, syncs', async () => {
    const db = createDb();
    synced(db, A, null); // e.g. a lock taken by a sync that never finished
    expect(getStaleSourcesForType(db, 'tasks').map(s => s.sourceId).sort()).toEqual([A, B]);
    expect(await ensureSyncForType(db, 'tasks')).toBe(true);
    expect(reads()).toEqual([A, B]);
  });

  test('all sources fresh: nothing syncs', async () => {
    const db = createDb();
    synced(db, A, 0);
    synced(db, B, 1);
    expect(readSyncNeeded(db, 'tasks')).toBe(false);
    expect(await ensureSyncForType(db, 'tasks')).toBe(false);
    expect(reads()).toEqual([]);
  });

  test('force syncs every enabled source, fresh or not', async () => {
    const db = createDb();
    synced(db, A, 0);
    synced(db, B, 0);
    expect(await ensureSyncForType(db, 'tasks', { force: true })).toBe(true);
    expect(reads()).toEqual([A, B]);
  });

  test('staleMinutes 0 always syncs', async () => {
    const db = createDb();
    synced(db, A, 0);
    synced(db, B, 0);
    expect(readSyncNeeded(db, 'tasks', { staleMinutes: 0 })).toBe(true);
    expect(await ensureSyncForType(db, 'tasks', { staleMinutes: 0 })).toBe(true);
    expect(reads()).toEqual([A, B]);
  });

  test('CONTEXT_ONLY skips read syncs, but not a forced one', async () => {
    const db = createDb();
    process.env.CONTEXT_ONLY = 'true';
    expect(readSyncNeeded(db, 'tasks')).toBe(false);
    expect(await ensureSyncForType(db, 'tasks')).toBe(false);
    expect(reads()).toEqual([]);
    expect(await ensureSyncForType(db, 'tasks', { force: true })).toBe(true);
    expect(reads()).toEqual([A, B]);
  });

  test('a read with no changes still counts as a sync, so the next read skips the source', async () => {
    const db = createDb();
    synced(db, A, staleMinutes + 60);
    db.prepare(`UPDATE sync_metadata SET last_sync_files = '["a.md"]', entries_count = 3, extra_data = ? WHERE source = ?`)
      .run(JSON.stringify({ folder_state: { INBOX: 7 } }), A);
    const cursor = db.prepare('SELECT last_synced_at FROM sync_metadata WHERE source = ?').get(A).last_synced_at;
    synced(db, B, 0);
    db.prepare(`INSERT INTO tasks (id, title, status, source) VALUES ('a:1', 'Kept', 'open', ?)`).run(A);
    fs.writeFileSync(noChange, '');

    expect(await ensureSyncForType(db, 'tasks')).toBe(true);
    expect(reads()).toEqual([A]);
    expect(db.prepare('SELECT title FROM tasks WHERE source = ?').all(A)).toEqual([{ title: 'Kept' }]);
    const row = db.prepare('SELECT * FROM sync_metadata WHERE source = ?').get(A);
    const extra = JSON.parse(row.extra_data);
    expect((Date.now() - new Date(extra.checked_at + 'Z').getTime()) / 60000).toBeLessThan(1);
    // The reader's cursor, file list, row count and plugin state stay as the
    // last full sync left them.
    expect(row.last_synced_at).toBe(cursor);
    expect(row.last_sync_files).toBe('["a.md"]');
    expect(row.entries_count).toBe(3);
    expect(extra.folder_state).toEqual({ INBOX: 7 });

    expect(readSyncNeeded(db, 'tasks')).toBe(false);
    expect(await ensureSyncForType(db, 'tasks')).toBe(false);
    expect(reads()).toEqual([A]);
  });

  test('a filtered no-change read with keepSyncWatermark records nothing', async () => {
    const db = createDb();
    synced(db, A, staleMinutes + 60);
    const before = db.prepare('SELECT last_synced_at, extra_data FROM sync_metadata WHERE source = ?').get(A);
    fs.writeFileSync(noChange, '');
    const { plugin, sourceName, config } = getReadSourcesForType('tasks').find(s => s.sourceId === A);
    const result = await syncPluginSource(plugin, sourceName, config, { db, vaultPath: '/tmp/test-vault' }, {
      fileFilter: 'a.md', keepSyncWatermark: true, skipWriteHooks: true, _caller: 'test',
    });
    expect(result.success).toBe(true);
    expect(db.prepare('SELECT last_synced_at, extra_data FROM sync_metadata WHERE source = ?').get(A)).toEqual(before);
    expect(readSyncNeeded(db, 'tasks')).toBe(true);
  });

  test('a type with no enabled sources needs no sync', () => {
    expect(readSyncNeeded(createDb(), 'events')).toBe(false);
  });

  test('an empty read saves explicitly returned folder cursors without replacing other sync metadata', async () => {
    const db = createDb();
    synced(db, A, staleMinutes + 60);
    const oldState = {
      INBOX: { uidNext: 10, highestModseq: '20' },
      Failed: { uidNext: 5, highestModseq: '8' }
    };
    const folder_state = {
      ...oldState,
      INBOX: { uidNext: 11, highestModseq: '30' }
    };
    db.prepare(`UPDATE sync_metadata SET last_sync_files = '["a.md"]', entries_count = 3, extra_data = ? WHERE source = ?`)
      .run(JSON.stringify({ folder_state: oldState, config_fingerprint: 'kept' }), A);
    const before = db.prepare('SELECT * FROM sync_metadata WHERE source = ?').get(A);
    fs.writeFileSync(noChange, JSON.stringify({ folder_state }));
    const { plugin, sourceName, config } = getReadSourcesForType('tasks').find(s => s.sourceId === A);

    const result = await syncPluginSource(plugin, sourceName, config, { db, vaultPath: '/tmp/test-vault' }, {
      skipWriteHooks: true, _caller: 'test'
    });
    expect(result.success).toBe(true);
    const after = db.prepare('SELECT * FROM sync_metadata WHERE source = ?').get(A);
    expect(after.last_synced_at).toBe(before.last_synced_at);
    expect(after.last_sync_files).toBe(before.last_sync_files);
    expect(after.entries_count).toBe(before.entries_count);
    expect(JSON.parse(after.extra_data)).toMatchObject({
      folder_state, config_fingerprint: 'kept', checked_at: expect.any(String)
    });
    db.close();
  });

  test('the "Last synced" hint goes by the oldest source', () => {
    const db = createDb();
    synced(db, A, 0);
    expect(getOldestSyncTimeForType(db, 'tasks')).toBeNull(); // B has never synced
    expect(getSyncStatusMessage(db, 'tasks')).toMatch(/^Last synced: never/);
    synced(db, B, 120);
    expect(getSyncStatusMessage(db, 'tasks')).toMatch(/^Last synced: 2h ago/);
  });
});
