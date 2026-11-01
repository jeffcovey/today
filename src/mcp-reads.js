/**
 * Read helpers for the MCP server: bounded freshness syncs and paged task lists.
 *
 * Kept apart from mcp-server.js so they can be tested against a plain SQLite
 * database without standing up the whole server.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readSyncNeeded, getStaleSourcesForType, envFreshnessForChild } from './plugin-loader.js';
import { getTodayDate } from './date-utils.js';

const READ_SYNC_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'read-sync-worker.js');

// How long a read waits for its pre-read sync before answering from the
// cache. MCP clients give a tool call a few minutes at most (claude.ai gave
// list_events 240s), while one stale read can sync every source of a type in
// turn, each bounded only by the 8-minute plugin command timeout.
export const READ_SYNC_BUDGET_MS = 20 * 1000;

// A worker that outlives this is killed. Each plugin command inside it is
// already bounded at 8 minutes; this stops a type with many slow sources from
// holding its locks indefinitely.
export const READ_SYNC_WORKER_MAX_MS = 30 * 60 * 1000;

// SIGTERM gives the worker this long to stop its plugin commands and exit.
// A worker stuck in a synchronous call can't run its SIGTERM handler, so it
// is then sent SIGKILL.
export const READ_SYNC_WORKER_KILL_GRACE_MS = 10 * 1000;

/**
 * Run ensureSyncForType for one type in a child process (#690).
 *
 * Much of a sync is synchronous: better-sqlite3 writes and lock updates that
 * can wait out the 30-second busy timeout, and the first dotenvx secret
 * lookup. In-process, those stop the read budget's timer and every other
 * request the server is handling. In a child they can't; the database is in
 * WAL mode, so this process keeps reading while the child writes.
 *
 * The child runs from this process's working directory so it opens the same
 * database, and its stdout goes to stderr so it can never write into a stdio
 * MCP transport.
 *
 * @returns {Promise<boolean>} true if the worker exited 0 (see
 *   read-sync-worker.js for what that does and doesn't mean)
 */
export function runReadSyncInChild(pluginType, {
  workerPath = READ_SYNC_WORKER,
  maxMs = READ_SYNC_WORKER_MAX_MS,
  killGraceMs = READ_SYNC_WORKER_KILL_GRACE_MS,
} = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(process.execPath, [workerPath, pluginType], {
        cwd: process.cwd(),
        // The decrypted secrets this process holds, and which .env they came
        // from, so the worker reloads them if .env has changed since.
        env: { ...process.env, ...envFreshnessForChild() },
        stdio: ['ignore', 2, 2],
      });
    } catch {
      resolve(false);
      return;
    }
    let escalate;
    const killer = setTimeout(() => {
      child.kill('SIGTERM');
      escalate = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      if (typeof escalate.unref === 'function') escalate.unref();
    }, maxMs);
    if (typeof killer.unref === 'function') killer.unref();
    const done = ok => {
      clearTimeout(killer);
      clearTimeout(escalate);
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('exit', code => done(code === 0));
  });
}

// One sync per type at a time in this process: a read that arrives while an
// earlier read's sync is still running waits on that one, not a second sync.
const inflight = new Map();

/**
 * Freshen a plugin type before a read, but wait no longer than budgetMs.
 * If the sync is still running when the budget runs out, it carries on in the
 * background and the caller answers from what the database already holds.
 *
 * @returns {Promise<{complete: boolean, due: Array<{sourceId: string, lastSync: Date|null}>}>}
 *   complete is false when the read is answered before the sync finished;
 *   due then lists the sources still waiting for theirs.
 */
export async function syncForRead(db, pluginType, options = {}) {
  const {
    budgetMs = READ_SYNC_BUDGET_MS,
    sync = (_db, type) => runReadSyncInChild(type),
    needed = readSyncNeeded,
    staleSources = getStaleSourcesForType,
  } = options;

  let pending = inflight.get(pluginType);
  // Fresh data needs no worker; this is the common case and costs one query.
  if (!pending && !needed(db, pluginType)) {
    return { complete: true, due: [] };
  }
  if (!pending) {
    pending = Promise.resolve()
      .then(() => sync(db, pluginType))
      .catch(() => false) // reads never fail on a sync error
      .finally(() => inflight.delete(pluginType));
    inflight.set(pluginType, pending);
  }

  let timer;
  const timedOut = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  const outcome = await Promise.race([pending.then(() => 'done'), timedOut]);
  clearTimeout(timer);

  if (outcome === 'done') return { complete: true, due: [] };
  // Sources sync one at a time, so the ones already done are fresh by now and
  // the rest are still due.
  let due = [];
  try {
    due = staleSources(db, pluginType).map(({ sourceId, lastSync }) => ({ sourceId, lastSync: lastSync || null }));
  } catch {
    // The note just names no sources
  }
  return { complete: false, due };
}

/**
 * Wait for any read syncs this process left running in the background, so an
 * explicit sync doesn't skip their sources as locked and call itself done.
 * With no type, waits for all of them.
 */
export async function waitForReadSyncs(pluginType) {
  const pending = pluginType
    ? [inflight.get(pluginType)].filter(Boolean)
    : [...inflight.values()];
  await Promise.all(pending);
}

const STALE_NOTE_MAX_SOURCES = 3;

/**
 * A line telling the client its data may be behind, or null when the sync
 * finished in time. Names the sources still waiting for their sync and when
 * each last synced, since each source is synced on its own clock.
 */
export function staleNote(label, syncResult) {
  if (syncResult.complete) return null;
  const due = syncResult.due || [];
  const named = due.slice(0, STALE_NOTE_MAX_SOURCES).map(({ sourceId, lastSync }) =>
    `${sourceId} (${lastSync ? `last synced ${lastSync.toISOString()}` : 'never synced'})`);
  const more = due.length > named.length ? `, and ${due.length - named.length} more` : '';
  const waiting = named.length > 0 ? ` Still to refresh: ${named.join(', ')}${more}.` : '';
  return `Note: a ${label} sync is still running, so this comes from the database as it stood.${waiting} Call again in a minute for fresher data.`;
}

export const LIST_TASKS_DEFAULT_LIMIT = 100;
export const LIST_TASKS_MAX_LIMIT = 500;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * The list_tasks query, with the total count so a capped page says so.
 *
 * @returns {{total: number, returned: number, offset: number, limit: number,
 *   has_more: boolean, next_offset: number|null, tasks: object[]}}
 */
export function listTasks(db, args = {}, { today = getTodayDate() } = {}) {
  const conditions = [];
  const params = [];

  if (!args.include_completed) {
    conditions.push("status = 'open'");
  }

  if (args.today_only) {
    conditions.push("(due_date <= ? OR json_extract(metadata, '$.scheduled_date') <= ?)");
    params.push(today, today);
  }

  if (args.stage) {
    conditions.push("json_extract(metadata, '$.stage') = ?");
    params.push(args.stage);
  }

  if (args.priority) {
    conditions.push('priority = ?');
    params.push(args.priority);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // limit 0 or a missing limit means the default; anything else is held to
  // 1..MAX so one call cannot pull the whole table into a client's context.
  const limit = args.limit ? clampInt(args.limit, LIST_TASKS_DEFAULT_LIMIT, 1, LIST_TASKS_MAX_LIMIT) : LIST_TASKS_DEFAULT_LIMIT;
  const offset = clampInt(args.offset ?? 0, 0, 0, Number.MAX_SAFE_INTEGER);

  // One read transaction, so the count and the page come from the same
  // snapshot even if another process's sync writes in between.
  const read = db.transaction(() => {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM tasks ${whereClause}`).get(...params).n;
    // id breaks ties so pages are stable and offset paging neither skips nor
    // repeats a task.
    const rows = db.prepare(`
      SELECT id, title, status, priority, due_date, metadata, source
      FROM tasks
      ${whereClause}
      ORDER BY
        CASE priority
          WHEN 'highest' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          WHEN 'lowest' THEN 5
          ELSE 6
        END,
        due_date NULLS LAST,
        id
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return { count, rows };
  });
  const { count: total, rows: tasks } = read();

  const hasMore = offset + tasks.length < total;
  return {
    total,
    returned: tasks.length,
    offset,
    limit,
    has_more: hasMore,
    next_offset: hasMore ? offset + tasks.length : null,
    tasks,
  };
}

/**
 * The list_tasks tool's text: a one-line summary first, so a truncated list
 * can't be mistaken for the whole one, then the page as JSON.
 */
export function formatTaskList(result) {
  const summary = result.has_more
    ? `Showing tasks ${result.offset + 1}-${result.offset + result.returned} of ${result.total}. More exist: call list_tasks again with offset: ${result.next_offset} (and the same filters) for the next page.`
    : result.offset > 0
      ? `Showing tasks ${result.returned === 0 ? 'none' : `${result.offset + 1}-${result.offset + result.returned}`} of ${result.total}. This is the last page.`
      : `Showing all ${result.total} matching tasks.`;
  return `${summary}\n${JSON.stringify(result, null, 2)}`;
}
