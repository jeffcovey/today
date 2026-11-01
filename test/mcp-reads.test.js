/**
 * list_tasks reports when its page is partial, and an MCP read never waits
 * longer than its budget on the freshness sync before it.
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
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
  const lastSync = new Date('2026-11-01T12:00:00Z');

  test('waits for a sync that finishes inside the budget', async () => {
    const sync = jest.fn(async () => true);
    const result = await syncForRead({}, 'events-fast', { sync, budgetMs: 1000, lastSyncTime: () => lastSync });
    expect(result).toEqual({ complete: true, lastSync: null });
    expect(staleNote('calendar', result)).toBeNull();
  });

  test('answers after the budget when the sync runs long, and says so', async () => {
    let finish;
    const sync = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    const started = Date.now();
    const result = await syncForRead({}, 'events-slow', { sync, budgetMs: 50, lastSyncTime: () => lastSync });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ complete: false, lastSync });
    expect(staleNote('calendar', result)).toBe(
      'Note: a calendar sync is still running, so this comes from the database as it stood. '
      + 'The most recent calendar source sync started at 2026-11-01T12:00:00.000Z; other sources may be older. '
      + 'Call again in a minute for fresher data.'
    );

    // A second read while the first sync runs joins it rather than starting another.
    const again = await syncForRead({}, 'events-slow', { sync, budgetMs: 20, lastSyncTime: () => lastSync });
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
    const after = await syncForRead({}, 'events-slow', { sync: async () => false, budgetMs: 50 });
    expect(after.complete).toBe(true);
  });

  test('a sync that throws still lets the read go ahead', async () => {
    const sync = jest.fn(async () => { throw new Error('calendar down'); });
    const result = await syncForRead({}, 'events-broken', { sync, budgetMs: 1000 });
    expect(result.complete).toBe(true);
  });
});

describe('syncForRead without a stale type', () => {
  test('fresh data starts no sync at all', async () => {
    const sync = jest.fn(async () => true);
    const result = await syncForRead({}, 'events-fresh', { sync, needed: () => false });
    expect(result).toEqual({ complete: true, lastSync: null });
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

  test('a worker that blocks its own event loop does not block the read budget', async () => {
    // Two seconds of synchronous work, like a long better-sqlite3 write.
    const busy = worker('busy.mjs', 'const end = Date.now() + 2000; while (Date.now() < end) {} process.exit(0);');
    const started = Date.now();
    const result = await syncForRead({}, 'events-busy', {
      needed: () => true,
      sync: (_db, type) => runReadSyncInChild(type, { workerPath: busy }),
      budgetMs: 100,
      lastSyncTime: () => null,
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
