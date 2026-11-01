/**
 * restart_timer and add_time_entry: the MCP versions of `bin/track restart`
 * and `bin/track add`.
 *
 * Both write through the time-logs plugin's write command with
 * writeEntryAndSync, the same path start_timer and bin/track use.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { writeEntryAndSync, getWritableSource } from '../plugin-loader.js';
import { getConfiguredTimezone } from '../date-utils.js';
import { parseDuration, formatDurationMinutes } from '../duration-utils.js';
import { staleNote } from '../mcp-reads.js';
import { jsonResult, errorResult } from '../mcp-safeguards.js';
import { parseCallerTime, formatInZone } from './_time.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MAX_ENTRY_MINUTES = 24 * 60;
// A start a little past "now" from clock drift between client and server is fine.
const FUTURE_SLACK_MS = 60 * 1000;

function deps(ctx) {
  return {
    write: ctx.writeEntryAndSync || writeEntryAndSync,
    writableSource: ctx.getWritableSource || getWritableSource,
    now: ctx.now ? ctx.now() : new Date(),
  };
}

function runningTimers(db) {
  return db.prepare(`
    SELECT id, source, start_time, description
    FROM time_logs
    WHERE end_time IS NULL OR end_time = ''
    ORDER BY julianday(start_time) DESC
  `).all();
}

function relFile(file) {
  return file ? path.relative(PROJECT_ROOT, file) : null;
}

/** A description is one line in a pipe-separated file. */
function descriptionProblem(description) {
  if (!description) return 'description is required';
  if (/[\r\n]/.test(description)) return 'description must be one line';
  if (description.includes('|')) return 'description may not contain "|", which separates fields in the time log';
  if (description.length > 500) return 'description is longer than 500 characters';
  return null;
}

async function restartTimer(args, ctx) {
  const { db } = ctx;
  const { write, now } = deps(ctx);
  const tz = getConfiguredTimezone();
  const sync = ctx.syncForRead ? await ctx.syncForRead(db, 'time-logs') : null;
  const note = staleNote('time log', sync);

  const running = runningTimers(db);
  if (running.length > 0) {
    const t = running[0];
    return errorResult(`A timer is already running: "${t.description}" since ${formatInZone(t.start_time, tz)} (${t.source}). ` +
      'Stop it first; nothing was changed.');
  }

  const filter = args.source ? String(args.source) : null;
  const last = db.prepare(`
    SELECT source, start_time, end_time, description
    FROM time_logs
    WHERE end_time IS NOT NULL AND end_time != ''
      ${filter ? 'AND instr(source, ?) > 0' : ''}
    ORDER BY julianday(end_time) DESC
    LIMIT 1
  `).get(...(filter ? [filter] : []));
  if (!last) {
    return errorResult(filter ? `No finished time entries in a source matching "${filter}" to restart` : 'No finished time entries to restart');
  }
  if (descriptionProblem(last.description)) return errorResult(`The last entry can't be restarted: ${descriptionProblem(last.description)}`);

  const entry = { start_time: formatInZone(now, tz), end_time: null, description: last.description };
  const result = await write('time-logs', entry, { db, sourceFilter: last.source });
  if (!result.success) return errorResult(result.error);

  return jsonResult({
    started: { description: entry.description, start_time: entry.start_time, source: result.source?.sourceId || last.source },
    restarted_from: {
      start_time: formatInZone(last.start_time, tz),
      end_time: formatInZone(last.end_time, tz),
    },
    file: relFile(result.writeResult?.file),
    user_timezone: tz,
  }, [note, `Started a timer for "${entry.description}" at ${entry.start_time}.`].filter(Boolean).join('\n'));
}

async function addTimeEntry(args, ctx) {
  const { db } = ctx;
  const { write, writableSource, now } = deps(ctx);
  const tz = getConfiguredTimezone();

  const description = typeof args.description === 'string' ? args.description.trim() : '';
  const problem = descriptionProblem(description);
  if (problem) return errorResult(problem);

  const minutes = parseDuration(args.duration);
  if (!minutes) {
    return errorResult(`Could not read duration "${args.duration ?? ''}". Use forms like 20m, 1.5h, 2h or 1h30m.`);
  }
  if (minutes > MAX_ENTRY_MINUTES) {
    return errorResult(`${formatDurationMinutes(minutes)} is longer than 24 hours; add long stretches as separate entries. Nothing was added.`);
  }

  let start;
  let end;
  if (args.start !== undefined && args.start !== null && args.start !== '') {
    const parsed = parseCallerTime(args.start, tz, { allowTimeOnly: true });
    if (parsed.error) return errorResult(parsed.error);
    start = parsed.date;
    end = new Date(start.getTime() + minutes * 60000);
  } else {
    end = new Date(Math.floor(now.getTime() / 1000) * 1000);
    start = new Date(end.getTime() - minutes * 60000);
  }
  if (end.getTime() > now.getTime() + FUTURE_SLACK_MS) {
    return errorResult(`That entry would end at ${formatInZone(end, tz)}, which is in the future. ` +
      'add_time_entry records work already done; use start_timer for work starting now. Nothing was added.');
  }

  const target = await writableSource('time-logs', args.source || null);
  if (!target.success) return errorResult(target.error);
  const sourceId = target.source.sourceId;

  // The plugin clears current-timer.md when it writes a finished entry, so a
  // timer running on this source would be lost. Note it and put it back.
  const sync = ctx.syncForRead ? await ctx.syncForRead(db, 'time-logs') : null;
  const note = staleNote('time log', sync);
  const running = runningTimers(db).find(t => t.source === sourceId) || null;

  const entry = { start_time: formatInZone(start, tz), end_time: formatInZone(end, tz), description };
  const result = await write('time-logs', entry, { db, sourceFilter: sourceId });
  if (!result.success) return errorResult(result.error);

  let timerNote = null;
  if (running) {
    const restore = { start_time: running.start_time, end_time: null, description: running.description };
    const restored = await write('time-logs', restore, { db, sourceFilter: sourceId });
    timerNote = restored.success
      ? `The running timer "${running.description}" was kept.`
      : `The entry was added, but the running timer "${running.description}" (started ${formatInZone(running.start_time, tz)}) ` +
        `was stopped by the write and could not be restored: ${restored.error}. Restart it with start_timer.`;
  }

  const lead = `Added ${formatDurationMinutes(minutes)}: "${description}", ${entry.start_time} to ${entry.end_time}.`;
  return jsonResult({
    entry: { ...entry, duration_minutes: minutes, source: sourceId },
    file: relFile(result.writeResult?.file),
    ...(timerNote ? { running_timer: timerNote } : {}),
    user_timezone: tz,
  }, [note, lead].filter(Boolean).join('\n'));
}

export const tools = [
  {
    name: 'restart_timer',
    kind: 'write',
    pluginType: 'time-logs',
    description: 'Start a new timer with the description of the most recent finished time entry (like `bin/track restart`). ' +
      'Refuses when a timer is already running. Returns the timer started.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Only restart the last entry from a time-logs source matching this' },
      },
    },
    handler: restartTimer,
  },
  {
    name: 'add_time_entry',
    kind: 'write',
    pluginType: 'time-logs',
    description: 'Record work done without a timer (like `bin/track add`). By default the entry ends now; pass start to place it. ' +
      'Refuses entries over 24 hours or that would end in the future. A timer running on the same source keeps running. ' +
      'Returns the entry with times in the user\'s time zone.',
    inputSchema: {
      type: 'object',
      properties: {
        duration: { type: 'string', description: 'How long: 20m, 1.5h, 2h, 1h30m' },
        description: { type: 'string', description: 'What was done, with #topic tags, e.g. "Reviewing pull requests #topic/programming"' },
        start: {
          type: 'string',
          description: 'When it started: ISO with an offset (2026-11-01T09:00:00-05:00), a local time (2026-11-01T09:00) ' +
            'or HH:MM for today, read in the user\'s time zone. Default: the entry ends now.',
        },
        source: { type: 'string', description: 'Time tracking source to use (if more than one)' },
      },
      required: ['duration', 'description'],
    },
    handler: addTimeEntry,
  },
];
