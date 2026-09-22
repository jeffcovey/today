import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { syncPluginSource } from '../src/plugin-loader.js';
import { getSqlColumns } from '../src/plugin-schemas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const CONTENT = [
  '2026-09-01T09:00:00-04:00|2026-09-01T10:00:00-04:00|Entry one #topic/a',
  '2026-09-02T09:00:00-04:00|2026-09-02T10:00:00-04:00|Entry two #topic/b',
  '2026-09-03T09:00:00-04:00|2026-09-03T10:00:00-04:00|Entry three #topic/c'
].join('\n') + '\n';

describe('filtered sync only purges files that are actually gone (#508)', () => {
  let tmp, timeDir, monthFile, db, plugin, cfg, ctx, relMonth;
  const rows = () => db.prepare('SELECT count(*) AS n FROM time_logs').get().n;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filtered-del-'));
    timeDir = path.join(tmp, 'vault', 'logs', 'time-tracking');
    fs.mkdirSync(timeDir, { recursive: true });
    monthFile = path.join(timeDir, '2026-09.md');
    fs.writeFileSync(monthFile, CONTENT);
    fs.writeFileSync(path.join(timeDir, 'current-timer.md'), '');
    relMonth = path.relative(repoRoot, monthFile);

    db = new Database(path.join(tmp, 'test.db'));
    db.exec(`CREATE TABLE time_logs (${getSqlColumns('time-logs')})`);
    db.exec(`CREATE TABLE sync_metadata (
      source TEXT PRIMARY KEY, sync_locked_at TEXT, sync_locked_by TEXT,
      last_synced_at TEXT, last_sync_files TEXT, entries_count INTEGER, extra_data TEXT)`);

    plugin = {
      name: 'markdown-time-tracking', type: 'time-logs',
      _path: path.join(repoRoot, 'plugins', 'markdown-time-tracking'),
      commands: { read: './read.js', write: './write.js' }
    };
    cfg = { directory: path.relative(repoRoot, timeDir), days_to_sync: 3650, auto_add_topics: false };
    ctx = { db, vaultPath: path.join(tmp, 'vault') };
    await syncPluginSource(plugin, 'local', cfg, ctx, { _caller: 'test' });
    expect(rows()).toBe(3);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A reader that skips a file it could not read coherently must not be taken
  // to mean the file was deleted. This is what stopping a timer does: the write
  // triggers a filtered sync while the file is still settling.
  test('keeps rows when the filtered file was skipped but still exists', async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-stub-'));
    fs.writeFileSync(path.join(stubDir, 'read.js'), `#!/usr/bin/env node
console.log(JSON.stringify({ entries: [], files_processed: [], incremental: true }));
`);
    fs.chmodSync(path.join(stubDir, 'read.js'), 0o755);
    try {
      await syncPluginSource(
        { ...plugin, _path: stubDir, commands: { read: './read.js' } },
        'local', cfg, ctx, { fileFilter: relMonth, _caller: 'write-sync' }
      );
      expect(rows()).toBe(3);
      expect(fs.existsSync(monthFile)).toBe(true);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test('still purges rows when the filtered file really was deleted', async () => {
    fs.rmSync(monthFile);
    await syncPluginSource(plugin, 'local', cfg, ctx, { fileFilter: relMonth, _caller: 'write-sync' });
    expect(rows()).toBe(0);
  });
});
