import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// The auto-tagger a sync skipped stays owed (auto_tag_pending) until a sync
// that runs it, apart from the file hooks (write_hooks_pending). A writable
// sync with skipAutoTag (ensureSyncForType's default, a post-write refresh)
// runs the file hooks but leaves the tagger owed, so the scheduler's next
// sync tags what was stored even when its own read finds no changes.

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const pluginDir = path.join(repoRoot, 'plugins', 'read-only-sync-tag-stub');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-sync-tag-'));
const marker = path.join(tmp, 'calls.log');
// When this file exists, the reader returns its entry even with a cursor, as
// if the file had changed since the last sync.
const changed = path.join(tmp, 'changed');

fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'plugin.toml'), `
name = "read-only-sync-tag-stub"
displayName = "Read-Only Sync Tag Stub"
description = "Stub plugin for owed auto-tagging tests"
type = "tasks"
access = "read-write"

[commands]
read = "./read.js"
write = "./write.js"

[settings.taggable_field]
type = "string"
default = "title"
`);
fs.writeFileSync(path.join(pluginDir, 'write.js'), `#!/usr/bin/env node
import fs from 'fs';
fs.appendFileSync(${JSON.stringify(marker)}, 'write\\n');
console.log(JSON.stringify({ archived: 0, files_modified: [] }));
`);
fs.writeFileSync(path.join(pluginDir, 'read.js'), `#!/usr/bin/env node
import fs from 'fs';
fs.appendFileSync(${JSON.stringify(marker)}, 'read\\n');
if (process.env.LAST_SYNC_TIME && !fs.existsSync(${JSON.stringify(changed)})) {
  console.log(JSON.stringify({ entries: [], files_processed: [], incremental: true }));
  process.exit(0);
}
console.log(JSON.stringify({ entries: [{ id: 'f.md:1', title: 'A task', status: 'open' }], files_processed: ['f.md'] }));
`);
fs.chmodSync(path.join(pluginDir, 'write.js'), 0o755);
fs.chmodSync(path.join(pluginDir, 'read.js'), 0o755);

const sourceConfig = { enabled: true, auto_add_topics: true };

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn().mockReturnValue({
    plugins: { 'read-only-sync-tag-stub': { default: sourceConfig } }
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

const runAutoTagger = jest.fn().mockResolvedValue({ tagged: 0, failed: 0, skipped: 0 });
jest.unstable_mockModule('../src/auto-tagger.js', () => ({
  runAutoTagger,
  createFileBasedUpdater: () => ({ update: () => false, flush: () => {} }),
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
const extra = db => JSON.parse(
  db.prepare('SELECT extra_data FROM sync_metadata WHERE source = ?').get('read-only-sync-tag-stub/default')?.extra_data || '{}'
);
// The MCP pre-read, a CLI or post-write refresh, and the scheduler.
const readOnlySync = db => ensureSyncForType(db, 'tasks', { force: true, skipWriteHooks: true });
const untaggedSync = db => ensureSyncForType(db, 'tasks', { force: true });
const schedulerSync = db => ensureSyncForType(db, 'tasks', { force: true, skipAutoTag: false });

describe('owed auto-tagging', () => {
  afterAll(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    runAutoTagger.mockClear();
    fs.rmSync(marker, { force: true });
    fs.rmSync(changed, { force: true });
  });

  test('read-only, then writable without tagging and no changes, then the scheduler tags', async () => {
    const db = createDb();

    await readOnlySync(db);
    expect(db.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);
    expect(extra(db).auto_tag_pending).toBe(true);

    await untaggedSync(db);
    expect(runAutoTagger).not.toHaveBeenCalled();
    expect(extra(db).auto_tag_pending).toBe(true);

    await schedulerSync(db);
    expect(runAutoTagger).toHaveBeenCalledTimes(1);
    expect(extra(db).auto_tag_pending).toBeUndefined();

    // Once it has run, an unchanged sync doesn't run it again.
    await schedulerSync(db);
    expect(runAutoTagger).toHaveBeenCalledTimes(1);
  });

  test('read-only, then writable without tagging that stores entries, then the scheduler tags', async () => {
    const db = createDb();

    await readOnlySync(db);
    fs.writeFileSync(changed, '');
    await untaggedSync(db);
    fs.rmSync(changed, { force: true });
    expect(runAutoTagger).not.toHaveBeenCalled();
    expect(extra(db).auto_tag_pending).toBe(true);

    await schedulerSync(db);
    expect(runAutoTagger).toHaveBeenCalledTimes(1);
    expect(extra(db).auto_tag_pending).toBeUndefined();
  });

  test('a writable sync without tagging runs the owed file hooks and leaves the tagger owed', async () => {
    sourceConfig.auto_archive_completed = true;
    try {
      const db = createDb();
      await readOnlySync(db);
      expect(calls()).toEqual(['read']);
      expect(extra(db)).toMatchObject({ write_hooks_pending: true, auto_tag_pending: true });

      fs.rmSync(marker, { force: true });
      await untaggedSync(db);
      expect(calls().filter(l => l === 'write').length).toBeGreaterThan(0);
      expect(runAutoTagger).not.toHaveBeenCalled();
      expect(extra(db).write_hooks_pending).toBeUndefined();
      expect(extra(db).auto_tag_pending).toBe(true);

      await schedulerSync(db);
      expect(runAutoTagger).toHaveBeenCalledTimes(1);
      expect(extra(db).auto_tag_pending).toBeUndefined();
    } finally {
      delete sourceConfig.auto_archive_completed;
    }
  });

  test('a sync that runs the tagger leaves nothing owed', async () => {
    const db = createDb();
    await schedulerSync(db);
    expect(runAutoTagger).toHaveBeenCalledTimes(1);
    expect(extra(db).auto_tag_pending).toBeUndefined();
    expect(extra(db).write_hooks_pending).toBeUndefined();
  });
});
