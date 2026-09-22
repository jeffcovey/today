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

describe('time-logs sync never deletes rows on a torn read (#508)', () => {
  let tmp, timeDir, monthFile, timerFile, db, plugin, cfg, ctx;

  const rows = () => db.prepare('SELECT count(*) AS n FROM time_logs').get().n;
  const lastSync = () => db.prepare(
    "SELECT last_synced_at AS t FROM sync_metadata WHERE source = 'markdown-time-tracking/local'"
  ).get()?.t;
  const sync = () => syncPluginSource(plugin, 'local', cfg, ctx, { _caller: 'test' });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'torn-read-'));
    timeDir = path.join(tmp, 'vault', 'logs', 'time-tracking');
    fs.mkdirSync(timeDir, { recursive: true });
    monthFile = path.join(timeDir, '2026-09.md');
    timerFile = path.join(timeDir, 'current-timer.md');
    fs.writeFileSync(monthFile, CONTENT);
    fs.writeFileSync(timerFile, '');

    db = new Database(path.join(tmp, 'test.db'));
    db.exec(`CREATE TABLE time_logs (${getSqlColumns('time-logs')})`);
    db.exec(`CREATE TABLE sync_metadata (
      source TEXT PRIMARY KEY, sync_locked_at TEXT, sync_locked_by TEXT,
      last_synced_at TEXT, last_sync_files TEXT, entries_count INTEGER, extra_data TEXT)`);

    plugin = {
      name: 'markdown-time-tracking',
      type: 'time-logs',
      _path: path.join(repoRoot, 'plugins', 'markdown-time-tracking'),
      commands: { read: './read.js', write: './write.js' }
    };
    cfg = { directory: path.relative(repoRoot, timeDir), days_to_sync: 3650, auto_add_topics: false };
    ctx = { db, vaultPath: path.join(tmp, 'vault') };

    await sync();
    expect(rows()).toBe(3);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Make the file look modified since the last sync, so it is read again.
  const markModifiedAfterLastSync = (file) => {
    const t = new Date(Date.parse(lastSync() + 'Z') + 5000);
    fs.utimesSync(file, t, t);
  };

  test('still removes rows when a file is genuinely emptied', async () => {
    fs.writeFileSync(monthFile, '');
    markModifiedAfterLastSync(monthFile);
    fs.writeFileSync(timerFile, 'Running now #topic/x\n2026-09-22T10:00:00-04:00\n');
    await sync();
    expect(rows()).toBe(1);
  });

  // A file that reads cleanly but parses to nothing (comments, malformed lines)
  // must still reconcile — it is not a torn read.
  test('removes rows for a file left holding only comments', async () => {
    fs.writeFileSync(monthFile, '# just a comment\n# and another\n');
    markModifiedAfterLastSync(monthFile);
    fs.writeFileSync(timerFile, 'Running now #topic/x\n2026-09-22T10:00:00-04:00\n');
    await sync();
    expect(rows()).toBe(1);
  });

  // The watermark is the moment the sync STARTED. A file written while a sync
  // was running must still look new to the next one, or its rows stay stale
  // for good. The stub returns an entry so the sync actually records a
  // watermark rather than taking the "nothing changed" early return.
  test('re-reads a file that was written while a sync was running', async () => {
    const relTimer = path.relative(repoRoot, timerFile);
    fs.writeFileSync(timerFile, 'Running now #topic/x\n2026-09-22T10:00:00-04:00\n');
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-stub-'));
    const extra = '2026-09-04T09:00:00-04:00|2026-09-04T10:00:00-04:00|Entry four #topic/d\n';
    fs.writeFileSync(path.join(stubDir, 'read.js'), `#!/usr/bin/env node
const fs = require('fs');
// a writer touches the month file while this sync is in flight...
fs.appendFileSync(${JSON.stringify(monthFile)}, ${JSON.stringify(extra)});
// ...and the sync runs on past it, into a later second
const until = Date.now() + 1500; while (Date.now() < until) {}
console.log(JSON.stringify({
  entries: [{ id: ${JSON.stringify(relTimer + ':0')}, start_time: '2026-09-22T10:00:00-04:00', end_time: null, duration_minutes: 0, description: 'Running now #topic/x' }],
  files_processed: [${JSON.stringify(relTimer)}],
  incremental: true
}));
`);
    fs.chmodSync(path.join(stubDir, 'read.js'), 0o755);
    try {
      await syncPluginSource(
        { ...plugin, _path: stubDir, commands: { read: './read.js' } },
        'local', cfg, ctx, { _caller: 'test' }
      );
      expect(rows()).toBe(4);           // 3 original + the running timer
      await sync();                     // the real reader must pick the file up
      expect(rows()).toBe(5);           // ...revealing the appended 4th entry
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test('does not wipe the source when the directory is missing', async () => {
    db.prepare("UPDATE sync_metadata SET last_synced_at = NULL WHERE source = 'markdown-time-tracking/local'").run();
    fs.renameSync(timeDir, `${timeDir}.away`);
    const before = lastSync();
    await sync();
    expect(rows()).toBe(3);
    // the cursor must not move, or restored files with older mtimes are skipped
    expect(lastSync()).toBe(before);
  });
});
