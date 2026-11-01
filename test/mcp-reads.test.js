/**
 * list_tasks reports when its page is partial, and an MCP read never waits
 * longer than its budget on the freshness sync before it.
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  listTasks,
  formatTaskList,
  syncForRead,
  runReadSyncInChild,
  waitForReadSyncs,
  staleNote,
  LIST_TASKS_DEFAULT_LIMIT,
  LIST_TASKS_MAX_LIMIT,
} from '../src/mcp-reads.js';

function taskDb(count, { today = '2026-11-01' } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, status TEXT, priority TEXT,
    due_date TEXT, metadata TEXT, source TEXT
  )`);
  const insert = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < count; i++) {
    const id = `markdown-tasks/default:${String(i).padStart(4, '0')}`;
    // Every task shares priority and due date, so only id orders them.
    insert.run(id, `Task ${i}`, 'open', 'medium', today, '{}', 'markdown-tasks/default');
  }
  return db;
}

describe('listTasks', () => {
  test('a capped page reports the total and how to get the rest', () => {
    const db = taskDb(95);
    const page = listTasks(db, { today_only: true, limit: 50 }, { today: '2026-11-01' });
    expect(page).toMatchObject({ total: 95, returned: 50, offset: 0, limit: 50, has_more: true, next_offset: 50 });

    const text = formatTaskList(page);
    expect(text.split('\n')[0]).toBe(
      'Showing tasks 1-50 of 95. More exist: call list_tasks again with offset: 50 (and the same filters) for the next page.'
    );
  });

  test('offset paging walks every task exactly once', () => {
    const db = taskDb(95);
    const first = listTasks(db, { limit: 50 });
    const second = listTasks(db, { limit: 50, offset: first.next_offset });
    expect(second).toMatchObject({ total: 95, returned: 45, offset: 50, has_more: false, next_offset: null });
    const ids = [...first.tasks, ...second.tasks].map(t => t.id);
    expect(new Set(ids).size).toBe(95);
    expect(formatTaskList(second).split('\n')[0]).toBe('Showing tasks 51-95 of 95. This is the last page.');
  });

  test(`the default limit is ${LIST_TASKS_DEFAULT_LIMIT}, so 95 tasks come back whole`, () => {
    const db = taskDb(95);
    const page = listTasks(db, {});
    expect(page).toMatchObject({ total: 95, returned: 95, limit: LIST_TASKS_DEFAULT_LIMIT, has_more: false });
    expect(formatTaskList(page).split('\n')[0]).toBe('Showing all 95 matching tasks.');
  });

  test('limit is held between 1 and the maximum', () => {
    const db = taskDb(3);
    expect(listTasks(db, { limit: 100000 }).limit).toBe(LIST_TASKS_MAX_LIMIT);
    expect(listTasks(db, { limit: -5 }).limit).toBe(1);
    expect(listTasks(db, { limit: 0 }).limit).toBe(LIST_TASKS_DEFAULT_LIMIT);
    expect(listTasks(db, { limit: 'lots' }).limit).toBe(LIST_TASKS_DEFAULT_LIMIT);
  });

  test('filters apply to the total as well as the page', () => {
    const db = taskDb(10);
    db.prepare("UPDATE tasks SET status = 'done' WHERE rowid <= 4").run();
    expect(listTasks(db, {}).total).toBe(6);
    expect(listTasks(db, { include_completed: true }).total).toBe(10);
  });

  test('an offset past the end is an empty last page, not an error', () => {
    const db = taskDb(5);
    const page = listTasks(db, { offset: 10 });
    expect(page).toMatchObject({ total: 5, returned: 0, has_more: false, next_offset: null });
    expect(formatTaskList(page).split('\n')[0]).toBe('Showing tasks none of 5. This is the last page.');
  });
});

describe('syncForRead', () => {
  const lastSync = new Date('2025-11-01T12:00:00Z');
  // Stands in for a stale type; readSyncNeeded is tested in plugin-loader-per-source-staleness.
  const needed = () => true;
  const staleSources = () => [
    { sourceId: 'google-calendar/work', lastSync },
    { sourceId: 'public-calendars/holidays', lastSync: null },
  ];

  test('waits for a sync that finishes inside the budget', async () => {
    const sync = jest.fn(async () => true);
    const result = await syncForRead({}, 'events-fast', { sync, needed, budgetMs: 1000, staleSources });
    expect(result).toEqual({ complete: true, due: [] });
    expect(staleNote('calendar', result)).toBeNull();
  });

  test('answers after the budget when the sync runs long, and says so', async () => {
    let finish;
    const sync = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    const started = Date.now();
    const result = await syncForRead({}, 'events-slow', { sync, needed, budgetMs: 50, staleSources });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ complete: false, due: staleSources() });
    expect(staleNote('calendar', result)).toBe(
      'Note: a calendar sync is still running, so this comes from the database as it stood. '
      + 'Still to refresh: google-calendar/work (last synced 2025-11-01T12:00:00.000Z), '
      + 'public-calendars/holidays (never synced). '
      + 'Call again in a minute for fresher data.'
    );

    // A second read while the first sync runs joins it rather than starting another.
    const again = await syncForRead({}, 'events-slow', { sync, needed, budgetMs: 20, staleSources });
    expect(again.complete).toBe(false);
    expect(sync).toHaveBeenCalledTimes(1);

    // An explicit sync waits for the background one rather than skipping its
    // locked sources.
    let waited = false;
    const waiting = waitForReadSyncs('events-slow').then(() => { waited = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(waited).toBe(false);
    finish(true);
    await waiting;
    expect(waited).toBe(true);
    const after = await syncForRead({}, 'events-slow', { sync: async () => false, needed, budgetMs: 50 });
    expect(after.complete).toBe(true);
  });

  test('sources this run already synced are not listed as due, even when always stale', async () => {
    // A type with staleMinutes 0 (time-logs) counts every source as stale, so
    // the ones this run finished still come back from staleSources.
    let finish;
    const sync = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    const old = new Date('2025-11-01T12:00:00Z');
    // Synced by this run: a second after the one it started in.
    const later = () => new Date(Date.now() + 1000);
    const alwaysStale = () => [
      { sourceId: 'markdown-time-tracking/a', lastSync: later() },
      { sourceId: 'markdown-time-tracking/b', lastSync: later() },
      { sourceId: 'markdown-time-tracking/c', lastSync: later() },
      { sourceId: 'markdown-time-tracking/d', lastSync: old },
      { sourceId: 'markdown-time-tracking/e', lastSync: null },
    ];
    const result = await syncForRead({}, 'time-logs-slow', { sync, needed, budgetMs: 30, staleSources: alwaysStale });
    expect(result).toEqual({
      complete: false,
      due: [
        { sourceId: 'markdown-time-tracking/d', lastSync: old },
        { sourceId: 'markdown-time-tracking/e', lastSync: null },
      ],
    });
    expect(staleNote('time', result)).toBe(
      'Note: a time sync is still running, so this comes from the database as it stood. '
      + 'Still to refresh: markdown-time-tracking/d (last synced 2025-11-01T12:00:00.000Z), '
      + 'markdown-time-tracking/e (never synced). '
      + 'Call again in a minute for fresher data.'
    );
    finish(true);
    await waitForReadSyncs('time-logs-slow');
  });

  test('a run in the same second as the previous one counts none of its sync times as its own', async () => {
    // Two reads of an always-stale type within one second: the first run
    // syncs every source and finishes, the second starts and stalls on its
    // worker. sync_metadata keeps whole seconds, so the first run's times
    // equal the second run's start second. None of them is the second run's,
    // so every source is still due; one synced in a later second is not.
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T12:00:00.200Z'));
    try {
      const sameSecond = new Date('2026-11-01T12:00:00Z');
      const sources = () => [
        { sourceId: 'markdown-time-tracking/a', lastSync: sameSecond },
        { sourceId: 'markdown-time-tracking/b', lastSync: sameSecond },
      ];
      const first = await syncForRead({}, 'time-logs-twice', {
        sync: async () => true, needed, budgetMs: 1000, staleSources: sources,
      });
      expect(first).toEqual({ complete: true, due: [] });

      now.mockReturnValue(Date.parse('2026-11-01T12:00:00.700Z'));
      let finish;
      const sync = jest.fn(() => new Promise(resolve => { finish = resolve; }));
      const second = await syncForRead({}, 'time-logs-twice', { sync, needed, budgetMs: 30, staleSources: sources });
      expect(sync).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ complete: false, due: sources() });

      const nextSecond = new Date('2026-11-01T12:00:01Z');
      const third = await syncForRead({}, 'time-logs-twice', {
        sync, needed, budgetMs: 20,
        staleSources: () => [
          { sourceId: 'markdown-time-tracking/a', lastSync: nextSecond },
          { sourceId: 'markdown-time-tracking/b', lastSync: sameSecond },
        ],
      });
      expect(third).toEqual({ complete: false, due: [{ sourceId: 'markdown-time-tracking/b', lastSync: sameSecond }] });
      finish(true);
      await waitForReadSyncs('time-logs-twice');
    } finally {
      now.mockRestore();
    }
  });

  test('the note names at most three sources, and says how many more', () => {
    const due = ['a/1', 'b/1', 'c/1', 'd/1', 'e/1'].map(sourceId => ({ sourceId, lastSync: null }));
    expect(staleNote('tasks', { complete: false, due })).toBe(
      'Note: a tasks sync is still running, so this comes from the database as it stood. '
      + 'Still to refresh: a/1 (never synced), b/1 (never synced), c/1 (never synced), and 2 more. '
      + 'Call again in a minute for fresher data.'
    );
    expect(staleNote('tasks', { complete: false, due: [] })).toBe(
      'Note: a tasks sync is still running, so this comes from the database as it stood. Call again in a minute for fresher data.'
    );
  });

  test('a sync that throws still lets the read go ahead', async () => {
    const sync = jest.fn(async () => { throw new Error('calendar down'); });
    const result = await syncForRead({}, 'events-broken', { sync, needed, budgetMs: 1000 });
    expect(result.complete).toBe(true);
  });
});

describe('syncForRead without a stale type', () => {
  test('fresh data starts no sync at all', async () => {
    const sync = jest.fn(async () => true);
    const result = await syncForRead({}, 'events-fresh', { sync, needed: () => false });
    expect(result).toEqual({ complete: true, due: [] });
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('runReadSyncInChild', () => {
  let dir;
  const worker = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-sync-worker-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('resolves true on a clean exit and false on a failure', async () => {
    await expect(runReadSyncInChild('events', { workerPath: worker('ok.mjs', 'process.exit(0);') })).resolves.toBe(true);
    await expect(runReadSyncInChild('events', { workerPath: worker('fail.mjs', 'process.exit(1);') })).resolves.toBe(false);
    await expect(runReadSyncInChild('events', { workerPath: path.join(dir, 'missing.mjs') })).resolves.toBe(false);
  });

  test('passes the type and kills a worker that runs too long', async () => {
    const typeFile = path.join(dir, 'type.txt');
    await runReadSyncInChild('tasks', {
      workerPath: worker('type.mjs', `import fs from 'fs'; fs.writeFileSync(${JSON.stringify(typeFile)}, process.argv[2]);`),
    });
    expect(fs.readFileSync(typeFile, 'utf8')).toBe('tasks');

    const hang = worker('hang.mjs', 'setInterval(() => {}, 1000);');
    await expect(runReadSyncInChild('events', { workerPath: hang, maxMs: 200 })).resolves.toBe(false);
  });

  test('a worker that ignores SIGTERM is sent SIGKILL after the grace period', async () => {
    // Like a worker stuck in a synchronous call, which can't run its handler.
    const stuck = worker('stuck.mjs', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const started = Date.now();
    await expect(runReadSyncInChild('events', { workerPath: stuck, maxMs: 200, killGraceMs: 200 }))
      .resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('passes on which .env its decrypted secrets came from', async () => {
    const seen = path.join(dir, 'env.json');
    await runReadSyncInChild('events', {
      workerPath: worker('env.mjs', `import fs from 'fs'; fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
        mtime: process.env.TODAY_PROCESS_ENV_MTIME_MS, refreshed: process.env.TODAY_REFRESHED_ENV_MTIMES }));`),
    });
    const { mtime, refreshed } = JSON.parse(fs.readFileSync(seen, 'utf8'));
    expect(mtime).toMatch(/^(none|\d+(\.\d+)?)$/);
    expect(JSON.parse(refreshed)).toEqual(expect.any(Object));
  });

  test('a worker that blocks its own event loop does not block the read budget', async () => {
    // Two seconds of synchronous work, like a long better-sqlite3 write.
    const busy = worker('busy.mjs', 'const end = Date.now() + 2000; while (Date.now() < end) {} process.exit(0);');
    const started = Date.now();
    const result = await syncForRead({}, 'events-busy', {
      needed: () => true,
      sync: (_db, type) => runReadSyncInChild(type, { workerPath: busy }),
      budgetMs: 100,
      staleSources: () => [],
    });
    expect(result.complete).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    await waitForReadSyncs('events-busy');
  });

  test('the real worker runs a sync against the working directory and exits cleanly', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'read-sync-real-'));
    const previous = process.env.TODAY_CONFIG;
    const cwd = process.cwd();
    try {
      fs.writeFileSync(path.join(work, 'config.toml'), '');
      process.env.TODAY_CONFIG = path.join(work, 'config.toml');
      process.chdir(work);
      await expect(runReadSyncInChild('events')).resolves.toBe(true);
      expect(fs.existsSync(path.join(work, '.data', 'today.db'))).toBe(true);
    } finally {
      process.chdir(cwd);
      if (previous === undefined) delete process.env.TODAY_CONFIG;
      else process.env.TODAY_CONFIG = previous;
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('a worker started with envFreshnessForChild', () => {
  // A child that imports plugin-loader with the given environment and prints
  // what it would pass on to a child of its own.
  const inherit = (env) => {
    const script = `
      import { envFreshnessForChild } from ${JSON.stringify(path.join(PROJECT_ROOT, 'src/plugin-loader.js'))};
      console.log(JSON.stringify({
        passes: envFreshnessForChild(),
        leftInEnv: Object.keys(process.env).filter(k => k.startsWith('TODAY_') && k.includes('ENV_MTIME')),
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').pop());
  };

  test("keeps the parent's .env time, not the file's, so a changed .env is reloaded", () => {
    const out = inherit({ TODAY_PROCESS_ENV_MTIME_MS: '1000', TODAY_REFRESHED_ENV_MTIMES: '{"TODAY_X":2000}' });
    expect(out.passes).toEqual({
      TODAY_PROCESS_ENV_MTIME_MS: '1000',
      TODAY_REFRESHED_ENV_MTIMES: '{"TODAY_X":2000}',
    });
    // Taken out of process.env, so plugin commands don't inherit them.
    expect(out.leftInEnv).toEqual([]);
  });

  test('a parent with no .env passes that on', () => {
    expect(inherit({ TODAY_PROCESS_ENV_MTIME_MS: 'none' }).passes.TODAY_PROCESS_ENV_MTIME_MS).toBe('none');
  });
});

describe('read-sync-worker shutdown', () => {
  // A zombie left for a parent that never reaps counts as gone.
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return true;
    }
  };

  test('SIGTERM stops plugin process groups, with SIGKILL, before the worker exits', async () => {
    const script = `
      import { execGroup, stopProcessGroupsBeforeExitOnSigterm } from ${JSON.stringify(path.join(PROJECT_ROOT, 'src/process-group.js'))};
      // Stands in for database-service.js, whose handler exits at once.
      process.on('SIGTERM', () => process.exit(1));
      stopProcessGroupsBeforeExitOnSigterm({ killGraceMs: 200 });
      execGroup('trap "" TERM; sleep 60; true', {
        timeoutMs: 60000,
        onSpawn: (handle) => console.log('GROUP_PID:' + handle.pid),
      }).catch(() => {});
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let groupPid;
    try {
      groupPid = await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error('no group pid')), 5000);
        child.stdout.on('data', (data) => {
          out += data;
          const match = out.match(/GROUP_PID:(\d+)/);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
      });
      // Let the group's shell set its trap before signalling.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      child.kill('SIGTERM');
      expect(await exited).toBe(143);
      expect(isAlive(groupPid)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      if (groupPid && isAlive(groupPid)) {
        try { process.kill(-groupPid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  });
});
