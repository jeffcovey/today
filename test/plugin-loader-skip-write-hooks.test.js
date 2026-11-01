import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// syncPluginSource's skipWriteHooks: a refresh after one MCP task edit must
// only read the file, not run the source-wide auto-archive hook (or the
// dating, stage and priority hooks next to it), which rewrite other tasks.

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const pluginDir = path.join(repoRoot, 'plugins', 'skip-write-hooks-stub');
const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skip-write-hooks-')), 'writes.log');

fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'plugin.toml'), `
name = "skip-write-hooks-stub"
displayName = "Skip Write Hooks Stub"
description = "Stub plugin for skipWriteHooks tests"
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
console.log(JSON.stringify({ entries: [{ id: 'f.md:1', title: 'A task', status: 'open' }], files_processed: ['f.md'] }));
`);
fs.chmodSync(path.join(pluginDir, 'write.js'), 0o755);
fs.chmodSync(path.join(pluginDir, 'read.js'), 0o755);

const sourceConfig = { enabled: true, auto_archive_completed: true };

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn().mockReturnValue({
    plugins: { 'skip-write-hooks-stub': { default: sourceConfig } }
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

const { syncPluginSource, getWritableSource } = await import('../src/plugin-loader.js');
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

const writes = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0);

describe('syncPluginSource skipWriteHooks', () => {
  afterAll(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
  });

  beforeEach(() => fs.rmSync(marker, { force: true }));

  test('a regular sync runs auto-archive', async () => {
    const { source } = await getWritableSource('tasks', 'skip-write-hooks-stub/default');
    const result = await syncPluginSource(source.plugin, source.sourceName, source.config, { db: createDb(), vaultPath: 'vault' }, { skipAutoTag: true, _caller: 'test' });
    expect(result.success).toBe(true);
    expect(writes()).toBe(1);
  });

  test('skipWriteHooks only reads', async () => {
    const db = createDb();
    const { source } = await getWritableSource('tasks', 'skip-write-hooks-stub/default');
    const result = await syncPluginSource(source.plugin, source.sourceName, source.config, { db, vaultPath: 'vault' }, {
      fileFilter: 'f.md', skipAutoTag: true, skipWriteHooks: true, _caller: 'test',
    });
    expect(result.success).toBe(true);
    expect(writes()).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);
  });

  test('keepSyncWatermark leaves the source\'s sync time and file list as they were', async () => {
    const db = createDb();
    db.prepare("INSERT INTO sync_metadata (source, last_synced_at, last_sync_files, extra_data) VALUES (?, '2026-01-01 00:00:00', '[\"a.md\",\"f.md\"]', '{\"k\":1}')")
      .run('skip-write-hooks-stub/default');
    const { source } = await getWritableSource('tasks', 'skip-write-hooks-stub/default');
    const result = await syncPluginSource(source.plugin, source.sourceName, source.config, { db, vaultPath: 'vault' }, {
      fileFilter: 'f.md', skipAutoTag: true, skipWriteHooks: true, keepSyncWatermark: true, _caller: 'test',
    });
    expect(result.success).toBe(true);
    const meta = db.prepare('SELECT last_synced_at, last_sync_files, extra_data FROM sync_metadata WHERE source = ?').get('skip-write-hooks-stub/default');
    expect(meta).toEqual({ last_synced_at: '2026-01-01 00:00:00', last_sync_files: '["a.md","f.md"]', extra_data: '{"k":1}' });
    expect(db.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);

    // Without it, a filtered re-read moves the sync time on, as before.
    await syncPluginSource(source.plugin, source.sourceName, source.config, { db, vaultPath: 'vault' }, {
      fileFilter: 'f.md', skipAutoTag: true, skipWriteHooks: true, _caller: 'test',
    });
    expect(db.prepare('SELECT last_synced_at FROM sync_metadata WHERE source = ?').get('skip-write-hooks-stub/default').last_synced_at).not.toBe('2026-01-01 00:00:00');
  });
});
