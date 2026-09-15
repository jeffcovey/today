import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pluginDir = path.join(repoRoot, 'plugins', 'write-sync-stub');

fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'plugin.toml'), `
name = "write-sync-stub"
displayName = "Write Sync Stub"
description = "Stub plugin for write/sync tests"
type = "tasks"

[commands]
read = "./read.js"
write = "./write.js"
`);
fs.writeFileSync(path.join(pluginDir, 'write.js'), `#!/usr/bin/env node
console.log(JSON.stringify({ needs_sync: true, marker: 'remote write ok' }));
`);
fs.writeFileSync(path.join(pluginDir, 'read.js'), `#!/usr/bin/env node
console.log(JSON.stringify({ entries: [], files_processed: [], incremental: true, error: 'simulated sync failure' }));
`);
fs.chmodSync(path.join(pluginDir, 'write.js'), 0o755);
fs.chmodSync(path.join(pluginDir, 'read.js'), 0o755);

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn().mockReturnValue({
    plugins: {
      'write-sync-stub': {
        default: { enabled: true }
      }
    }
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

const { writeEntryAndSync } = await import('../src/plugin-loader.js');
const { getSqlColumns } = await import('../src/plugin-schemas.js');
const Database = (await import('better-sqlite3')).default;

describe('writeEntryAndSync partial failures', () => {
  afterAll(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  test('surfaces when the write succeeds but the follow-up sync fails', async () => {
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

    const result = await writeEntryAndSync('tasks', { title: 'x' }, { db, vaultPath: 'vault' });

    expect(result.success).toBe(false);
    expect(result.partialSuccess).toBe(true);
    expect(result.error).toMatch(/Write succeeded, but local sync failed/);
    expect(result.error).toMatch(/simulated sync failure/);
    expect(result.writeResult.marker).toBe('remote write ok');
  });
});
