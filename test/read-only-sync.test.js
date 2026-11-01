import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// The MCP server's pre-read syncs are read-only: ensureSyncForType with
// skipWriteHooks runs no write hooks and starts the reader with
// READ_ONLY=true. Without it (sync_data, bin/, the scheduler), hooks run and
// the reader gets no READ_ONLY, as before.

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const pluginDir = path.join(repoRoot, 'plugins', 'read-only-sync-stub');
const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-sync-')), 'calls.log');

fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'plugin.toml'), `
name = "read-only-sync-stub"
displayName = "Read-Only Sync Stub"
description = "Stub plugin for read-only sync tests"
type = "tasks"
access = "read-write"

[commands]
read = "./read.js"
write = "./write.js"
`);
fs.writeFileSync(path.join(pluginDir, 'write.js'), `#!/usr/bin/env node
import fs from 'fs';
fs.appendFileSync(${JSON.stringify(marker)}, 'write\\n');
console.log(JSON.stringify({ archived: 0, files_modified: [] }));
`);
fs.writeFileSync(path.join(pluginDir, 'read.js'), `#!/usr/bin/env node
import fs from 'fs';
fs.appendFileSync(${JSON.stringify(marker)}, 'read READ_ONLY=' + (process.env.READ_ONLY ?? '') + '\\n');
// Like markdown-tasks once the source has a cursor: an incremental read
// reports only files changed since the vault-changes baseline, and f.md
// already matches it.
if (process.env.LAST_SYNC_TIME) {
  console.log(JSON.stringify({ entries: [], files_processed: [], incremental: true }));
  process.exit(0);
}
console.log(JSON.stringify({ entries: [{ id: 'f.md:1', title: 'A task', status: 'open' }], files_processed: ['f.md'] }));
`);
fs.chmodSync(path.join(pluginDir, 'write.js'), 0o755);
fs.chmodSync(path.join(pluginDir, 'read.js'), 0o755);

// Every write hook the loader has, so a read-only sync has to skip them all.
const sourceConfig = {
  enabled: true,
  auto_archive_completed: true,
  auto_add_date_created: true,
};

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn().mockReturnValue({
    plugins: { 'read-only-sync-stub': { default: sourceConfig } }
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

const { ensureSyncForType } = await import('../src/plugin-loader.js');
const { getSqlColumns } = await import('../src/plugin-schemas.js');
const Database = (await import('better-sqlite3')).default;

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

const calls = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);

describe('ensureSyncForType skipWriteHooks', () => {
  afterAll(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
  });

  beforeEach(() => fs.rmSync(marker, { force: true }));

  test('a read-only sync runs no write hooks and tells the reader', async () => {
    const db = createDb();
    expect(await ensureSyncForType(db, 'tasks', { force: true, skipWriteHooks: true })).toBe(true);
    expect(calls()).toEqual(['read READ_ONLY=true']);
    expect(db.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);
  });

  test('a default sync runs the write hooks, and the reader is not read-only', async () => {
    const db = createDb();
    expect(await ensureSyncForType(db, 'tasks', { force: true })).toBe(true);
    const log = calls();
    expect(log[0]).toBe('read READ_ONLY=');
    expect(log.filter(l => l === 'write').length).toBeGreaterThan(0);
    expect(log.some(l => l === 'read READ_ONLY=true')).toBe(false);
  });

  test('write hooks a read-only sync skipped run on the next writable sync, though it reads no changes', async () => {
    // Same database throughout. The read-only sync does the full first read,
    // stores the task and takes the cursor; the writable sync after it reads
    // incrementally and finds nothing new. The hooks act on the whole source,
    // so they still have to run once for what the read-only sync stored.
    const db = createDb();
    const pending = () => JSON.parse(
      db.prepare('SELECT extra_data FROM sync_metadata WHERE source = ?').get('read-only-sync-stub/default').extra_data || '{}'
    ).write_hooks_pending;

    await ensureSyncForType(db, 'tasks', { force: true, skipWriteHooks: true });
    expect(calls()).toEqual(['read READ_ONLY=true']);
    expect(db.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);
    expect(pending()).toBe(true);

    // Another read-only sync with no changes keeps them owed.
    fs.rmSync(marker, { force: true });
    await ensureSyncForType(db, 'tasks', { force: true, skipWriteHooks: true });
    expect(calls()).toEqual(['read READ_ONLY=true']);
    expect(pending()).toBe(true);

    fs.rmSync(marker, { force: true });
    await ensureSyncForType(db, 'tasks', { force: true });
    const log = calls();
    expect(log[0]).toBe('read READ_ONLY=');
    expect(log.filter(l => l === 'write').length).toBeGreaterThan(0);
    expect(pending()).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);

    // Once they've run, a writable sync with no changes runs none again.
    fs.rmSync(marker, { force: true });
    await ensureSyncForType(db, 'tasks', { force: true });
    expect(calls()).toEqual(['read READ_ONLY=']);
  });

  test('a read-only sync of a source with no write hooks enabled leaves none owed', async () => {
    const saved = { ...sourceConfig };
    delete sourceConfig.auto_archive_completed;
    delete sourceConfig.auto_add_date_created;
    try {
      const db = createDb();
      await ensureSyncForType(db, 'tasks', { force: true, skipWriteHooks: true });
      const extra = JSON.parse(db.prepare('SELECT extra_data FROM sync_metadata WHERE source = ?').get('read-only-sync-stub/default').extra_data);
      expect(extra.write_hooks_pending).toBeUndefined();
      expect(extra.config_fingerprint).toBeTruthy();
    } finally {
      Object.assign(sourceConfig, saved);
    }
  });
});

describe('read-sync-worker', () => {
  test('asks ensureSyncForType for a read-only sync', async () => {
    const ensure = jest.fn().mockResolvedValue(true);
    const fakeDb = {};
    // A fresh module registry, so the mocks below apply to the worker alone.
    jest.resetModules();
    jest.unstable_mockModule('../src/plugin-loader.js', () => ({ ensureSyncForType: ensure }));
    jest.unstable_mockModule('../src/database-service.js', () => ({ getDatabase: () => fakeDb }));
    jest.unstable_mockModule('../src/process-group.js', () => ({ stopProcessGroupsBeforeExitOnSigterm: jest.fn() }));

    const argv = process.argv;
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    process.argv = [argv[0], 'read-sync-worker.js', 'habits'];
    try {
      await import('../src/read-sync-worker.js');
    } finally {
      process.argv = argv;
      exit.mockRestore();
    }

    expect(ensure).toHaveBeenCalledWith(fakeDb, 'habits', { skipWriteHooks: true });
  });
});
