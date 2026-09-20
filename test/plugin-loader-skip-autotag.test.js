import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pluginDir = path.join(repoRoot, 'plugins', 'skip-autotag-stub');

fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'plugin.toml'), `
name = "skip-autotag-stub"
displayName = "Skip Autotag Stub"
description = "Stub plugin for auto-tag skipping tests"
type = "time-logs"

[commands]
read = "./read.js"
write = "./write.js"

[settings.taggable_field]
type = "string"
default = "description"
`);
fs.writeFileSync(path.join(pluginDir, 'write.js'), `#!/usr/bin/env node
console.log(JSON.stringify({ needs_sync: true }));
`);
fs.writeFileSync(path.join(pluginDir, 'read.js'), `#!/usr/bin/env node
console.log(JSON.stringify({ entries: [{ id: 'f.md:0', start_time: '2026-09-20T14:00:46-04:00', end_time: null, duration_minutes: 0, description: 'Untagged task' }], files_processed: ['f.md'] }));
`);
fs.chmodSync(path.join(pluginDir, 'write.js'), 0o755);
fs.chmodSync(path.join(pluginDir, 'read.js'), 0o755);

const sourceConfig = { enabled: true, auto_add_topics: true };

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn().mockReturnValue({
    plugins: { 'skip-autotag-stub': { default: sourceConfig } }
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

const { writeEntryAndSync, syncPluginSource, getWritableSource } = await import('../src/plugin-loader.js');
const { getSqlColumns } = await import('../src/plugin-schemas.js');
const Database = (await import('better-sqlite3')).default;

function createDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE time_logs (${getSqlColumns('time-logs')})`);
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

describe('auto-tagging and the write→sync path', () => {
  afterAll(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  beforeEach(() => runAutoTagger.mockClear());

  test('a regular sync runs the auto-tagger', async () => {
    const db = createDb();
    const { source } = await getWritableSource('time-logs', 'skip-autotag-stub/default');
    const result = await syncPluginSource(source.plugin, source.sourceName, source.config, { db, vaultPath: 'vault' }, { _caller: 'test' });
    expect(result.success).toBe(true);
    expect(runAutoTagger).toHaveBeenCalledTimes(1);
  });

  // Regression: starting a timer from the web UI waited on a multi-second AI
  // tagging call inside the post-write sync.
  test('writeEntryAndSync does not wait on the auto-tagger', async () => {
    const db = createDb();
    const result = await writeEntryAndSync('time-logs', { description: 'Untagged task' }, {
      db, vaultPath: 'vault', sourceFilter: 'skip-autotag-stub/default'
    });
    expect(result.success).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM time_logs').get().n).toBe(1);
    expect(runAutoTagger).not.toHaveBeenCalled();
  });
});
