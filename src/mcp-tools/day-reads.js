/**
 * Read tools for "what's on today?" (issue #686, High): the plan file, the
 * running timer, time entries, today's habits, open issues and a task search.
 * Each mirrors a bin/ command and reads what the plugins sync into the
 * database, or the plan file itself.
 */

import fs from 'fs';
import path from 'path';
import { getAbsoluteVaultPath, getFullConfig } from '../config.js';
import { getConfiguredTimezone, getTodayDate } from '../date-utils.js';
import { formatDurationMinutes, formatDuration, calculateDurationMinutes } from '../duration-utils.js';
import { jsonResult, textResult, errorResult } from '../mcp-safeguards.js';
import { PLAN_LEVELS, planFileName } from '../plan-files.js';
import { rolePlanDirectory } from '../../plugins/roles/plan-file.js';
import {
  isCalendarDate,
  addDays,
  clampInt,
  escapeLike,
  formatInstant,
  localDateOf,
  freshen,
  withNote,
  topicTags,
} from './_shared.js';

const SOURCE_PROP = { type: 'string', description: 'Only this plugin source (matched as part of its id, e.g. "markdown-time-tracking/default")' };
const DATE_PROP = { type: 'string', description: 'Date as YYYY-MM-DD (default: today in the configured time zone)' };

function badDate(name, value) {
  return errorResult(`${name} "${value}" is not a date written YYYY-MM-DD`);
}

// ---------------------------------------------------------------------------
// get_plan
// ---------------------------------------------------------------------------

export const PLAN_MAX_BYTES = 100 * 1024;

/**
 * Read the plan file for a date and level.
 * @returns {{exists: boolean, path: string, file: string, markdown?: string,
 *   bytes?: number, truncated?: boolean}}
 */
export function readPlanFile({ date, level, plansDirectory, vaultPath, maxBytes = PLAN_MAX_BYTES }) {
  const file = path.join(plansDirectory, planFileName(date, level));
  const rel = path.relative(vaultPath, file);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { exists: false, path: shown, file };
  }
  if (!stat.isFile()) return { exists: false, path: shown, file };
  const buffer = fs.readFileSync(file);
  let markdown = buffer.toString('utf8');
  let truncated = false;
  if (buffer.length > maxBytes) {
    // Cut on a character boundary, then drop a partial last line.
    markdown = buffer.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
    const lastBreak = markdown.lastIndexOf('\n');
    if (lastBreak > maxBytes / 2) markdown = markdown.slice(0, lastBreak + 1);
    truncated = true;
  }
  return { exists: true, path: shown, file, markdown, bytes: buffer.length, truncated };
}

const getPlan = {
  name: 'get_plan',
  kind: 'read',
  pluginType: 'context',
  description: 'Read a plan file from the vault: the day\'s plan (with role report blocks and the user\'s inline replies), or the week, month, quarter or year plan that contains a date. Returns the file\'s markdown, or says plainly that there is no such file.',
  inputSchema: {
    type: 'object',
    properties: {
      date: DATE_PROP,
      level: { type: 'string', enum: PLAN_LEVELS, description: 'Which plan: day (default), week, month, quarter or year' },
    },
  },
  handler: async (args = {}, ctx = {}) => {
    const tz = getConfiguredTimezone();
    const date = args.date ? String(args.date).trim() : getTodayDate(tz);
    if (!isCalendarDate(date)) return badDate('date', args.date);
    const level = args.level || 'day';
    if (!PLAN_LEVELS.includes(level)) return errorResult(`level must be one of ${PLAN_LEVELS.join(', ')}`);

    const vaultPath = ctx.vaultPath || getAbsoluteVaultPath();
    const plansDirectory = ctx.plansDirectory || rolePlanDirectory(vaultPath, getFullConfig());
    const plan = readPlanFile({ date, level, plansDirectory, vaultPath });
    const what = level === 'day' ? `day plan for ${date}` : `${level} plan containing ${date}`;

    if (!plan.exists) {
      return textResult(`There is no ${what}: ${plan.path} does not exist. The markdown-plans plugin creates plan files when it runs; nothing has been written for this one yet.`);
    }
    const size = plan.truncated
      ? `It is ${Math.round(plan.bytes / 1024)} KB, so only the first ${Math.round(PLAN_MAX_BYTES / 1024)} KB is shown (truncated).`
      : '';
    const lead = `The ${what} (${plan.path}). ${size}`.trim();
    return {
      content: [
        { type: 'text', text: lead },
        { type: 'text', text: plan.markdown },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// timer_status and list_time_entries
// ---------------------------------------------------------------------------

function sourceClause(source, column = 'source') {
  if (!source) return { sql: '', params: [] };
  return { sql: ` AND ${column} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(source)}%`] };
}

/** Running timers (end_time IS NULL), newest first, as bin/track status lists them. */
export function runningTimers(db, { source, tz, now = new Date() } = {}) {
  const src = sourceClause(source);
  const rows = db.prepare(`
    SELECT id, start_time, description, source
    FROM time_logs
    WHERE end_time IS NULL${src.sql}
    ORDER BY start_time DESC
  `).all(...src.params);
  return rows.map(row => {
    const minutes = Math.max(0, calculateDurationMinutes(row.start_time, now));
    return {
      description: row.description,
      start: formatInstant(row.start_time, tz),
      elapsed_minutes: minutes,
      elapsed: formatDurationMinutes(minutes),
      topics: topicTags(row.description),
      source: row.source,
    };
  });
}

const timerStatus = {
  name: 'timer_status',
  kind: 'read',
  pluginType: 'time-logs',
  description: 'Show the running time-tracking timer: its description, start time and elapsed time, or say that no timer is running (like bin/track status).',
  inputSchema: { type: 'object', properties: { source: SOURCE_PROP } },
  handler: async (args = {}, ctx = {}) => {
    const note = await freshen(ctx, 'time-logs', 'time log');
    const tz = getConfiguredTimezone();
    const timers = runningTimers(ctx.db, { source: args.source, tz, now: ctx.now || new Date() });
    const lead = timers.length === 0
      ? 'No timer running.'
      : timers.length === 1
        ? `Tracking "${timers[0].description}" since ${timers[0].start} (${timers[0].elapsed}).`
        : `${timers.length} timers are running.`;
    return withNote(jsonResult({ user_timezone: tz, running: timers.length > 0, timers }, lead), note);
  },
};

export const TIME_ENTRIES_MAX = 500;

/**
 * Time entries that started on local days startDate..endDate, plus running
 * timers when the range includes today, with totals like bin/track's.
 */
export function listTimeEntries(db, { startDate, endDate, source, tz, today, now = new Date(), limit = TIME_ENTRIES_MAX }) {
  const src = sourceClause(source);
  // Stored times usually carry the local offset; widen by a day each side and
  // pick the local day in JS so a timestamp written in UTC still lands right.
  const rows = db.prepare(`
    SELECT id, start_time, end_time, duration_minutes, description, source
    FROM time_logs
    WHERE SUBSTR(start_time, 1, 10) >= ? AND SUBSTR(start_time, 1, 10) <= ?${src.sql}
    ORDER BY start_time
  `).all(addDays(startDate, -1), addDays(endDate, 1), ...src.params);

  const includesToday = startDate <= today && today <= endDate;
  const running = includesToday
    ? db.prepare(`SELECT id, start_time, end_time, duration_minutes, description, source FROM time_logs WHERE end_time IS NULL${src.sql} ORDER BY start_time`).all(...src.params)
    : [];

  const seen = new Set();
  const entries = [];
  for (const row of [...rows, ...running]) {
    if (seen.has(row.id)) continue;
    const day = localDateOf(row.start_time, tz);
    const isRunning = row.end_time === null || row.end_time === undefined || row.end_time === '';
    const inRange = day !== null && day >= startDate && day <= endDate;
    if (!inRange && !(isRunning && includesToday)) continue;
    seen.add(row.id);
    const minutes = isRunning
      ? Math.max(0, calculateDurationMinutes(row.start_time, now))
      : (row.duration_minutes || Math.max(0, calculateDurationMinutes(row.start_time, row.end_time)));
    entries.push({
      date: day,
      start: formatInstant(row.start_time, tz),
      end: isRunning ? null : formatInstant(row.end_time, tz),
      running: isRunning,
      duration_minutes: minutes,
      duration: formatDurationMinutes(minutes),
      description: row.description,
      topics: topicTags(row.description),
      source: row.source,
    });
  }
  entries.sort((a, b) => String(a.start).localeCompare(String(b.start)));

  let totalMinutes = 0;
  let runningMinutes = 0;
  const byTopic = new Map();
  const byDay = new Map();
  for (const entry of entries) {
    if (entry.running) {
      runningMinutes += entry.duration_minutes;
      continue;
    }
    // Grouped by the entry's whole set of topics, as bin/track groups them.
    const key = entry.topics.length > 0 ? entry.topics.join(' ') : '(untagged)';
    totalMinutes += entry.duration_minutes;
    byTopic.set(key, (byTopic.get(key) || 0) + entry.duration_minutes);
    byDay.set(entry.date, (byDay.get(entry.date) || 0) + entry.duration_minutes);
  }
  const asList = (map, keyName) => [...map.entries()].map(([key, minutes]) => ({
    [keyName]: key, minutes, duration: formatDurationMinutes(minutes),
  }));

  const shown = entries.slice(0, limit);
  return {
    start_date: startDate,
    end_date: endDate,
    total_minutes: totalMinutes,
    total: formatDurationMinutes(totalMinutes),
    running_minutes: runningMinutes,
    totals_by_topic: asList(byTopic, 'topic').sort((a, b) => b.minutes - a.minutes),
    totals_by_day: asList(byDay, 'date').sort((a, b) => a.date.localeCompare(b.date)),
    count: entries.length,
    returned: shown.length,
    has_more: shown.length < entries.length,
    entries: shown,
  };
}

const listTimeEntriesTool = {
  name: 'list_time_entries',
  kind: 'read',
  pluginType: 'time-logs',
  description: 'List time-tracking entries for a day or a range (like bin/track today, yesterday, week and day <date>): each entry\'s start, end (or running), duration, description and #topic tags, with totals per topic and per day. Totals count finished entries; a running timer is listed and its time so far given as running_minutes.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'One day, YYYY-MM-DD. Leave out to use range.' },
      range: { type: 'string', enum: ['today', 'yesterday', 'week'], description: 'today (default), yesterday, or week (the last 7 days and today, as bin/track week)' },
      source: SOURCE_PROP,
      limit: { type: 'number', description: `Most entries to list (default and maximum ${TIME_ENTRIES_MAX}); totals always cover every entry` },
    },
  },
  handler: async (args = {}, ctx = {}) => {
    const tz = getConfiguredTimezone();
    const today = getTodayDate(tz);
    let startDate;
    let endDate;
    if (args.date) {
      const date = String(args.date).trim();
      if (!isCalendarDate(date)) return badDate('date', args.date);
      startDate = endDate = date;
    } else {
      const range = args.range || 'today';
      if (range === 'today') startDate = endDate = today;
      else if (range === 'yesterday') startDate = endDate = addDays(today, -1);
      else if (range === 'week') { startDate = addDays(today, -7); endDate = today; }
      else return errorResult('range must be today, yesterday or week');
    }
    const note = await freshen(ctx, 'time-logs', 'time log');
    const limit = clampInt(args.limit, TIME_ENTRIES_MAX, 1, TIME_ENTRIES_MAX);
    const result = listTimeEntries(ctx.db, {
      startDate, endDate, source: args.source, tz, today, now: ctx.now || new Date(), limit,
    });
    const span = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    const runningNote = result.running_minutes > 0 ? `, plus ${formatDurationMinutes(result.running_minutes)} on a running timer` : '';
    const more = result.has_more ? ` Showing the first ${result.returned}; the totals cover all of them.` : '';
    const lead = result.count === 0
      ? `No time entries for ${span}.`
      : `${result.count} time entr${result.count === 1 ? 'y' : 'ies'} for ${span}: ${result.total} tracked${runningNote}.${more}`;
    return withNote(jsonResult({ user_timezone: tz, ...result }, lead), note);
  },
};

// ---------------------------------------------------------------------------
// habits_today
// ---------------------------------------------------------------------------

/** A habit's progress as bin/habits today shows it, or null. */
function habitProgress(h) {
  if (h.goal_type === 'limit') {
    if (h.value !== null && h.value !== undefined && h.target_value) {
      return `${Number(h.value).toFixed(1).replace(/\.0$/, '')}/${h.target_value}`;
    }
    return null;
  }
  if (h.target_type === 'steps' && h.target_value) return `${h.value || 0}/${h.target_value}`;
  if (h.target_type === 'timer' && h.value) return formatDuration(Number(h.value));
  return null;
}

export function habitsForDate(db, { date, source }) {
  const src = sourceClause(source);
  const rows = db.prepare(`
    SELECT habit_id, title, status, value, category, goal_type, source,
           json_extract(metadata, '$.current_streak') AS streak,
           json_extract(metadata, '$.target_type') AS target_type,
           json_extract(metadata, '$.target_value') AS target_value
    FROM habits
    WHERE date = ?
      AND (json_extract(metadata, '$.recurrence') IS NULL
           OR json_extract(metadata, '$.recurrence') = 'daily')${src.sql}
    ORDER BY status DESC, category, title
  `).all(date, ...src.params);

  const counts = {};
  const habits = rows.map(h => {
    counts[h.status] = (counts[h.status] || 0) + 1;
    const out = {
      title: h.title,
      habit_id: h.habit_id,
      status: h.status,
      category: h.category ?? null,
      goal_type: h.goal_type ?? null,
      progress: habitProgress(h),
      value: h.value ?? null,
      target_type: h.target_type ?? null,
      target_value: h.target_value ?? null,
      streak: h.streak ?? null,
      source: h.source,
    };
    // A limit habit is "completed" while it stays under its limit.
    if (h.goal_type === 'limit') {
      out.meaning = h.status === 'skipped' ? 'over the limit' : (h.status === 'completed' || h.status === 'partial' ? 'under the limit' : null);
    }
    return out;
  });
  return { counts, habits };
}

const habitsToday = {
  name: 'habits_today',
  kind: 'read',
  pluginType: 'habits',
  description: 'List the day\'s habits and routine steps with their status (completed, pending, skipped, partial), progress such as "0/12" steps or time spent, and streaks (like bin/habits today). For a limit habit, completed means it stayed under its limit.',
  inputSchema: { type: 'object', properties: { date: DATE_PROP, source: SOURCE_PROP } },
  handler: async (args = {}, ctx = {}) => {
    const tz = getConfiguredTimezone();
    const date = args.date ? String(args.date).trim() : getTodayDate(tz);
    if (!isCalendarDate(date)) return badDate('date', args.date);
    const note = await freshen(ctx, 'habits', 'habits');
    const { counts, habits } = habitsForDate(ctx.db, { date, source: args.source });
    const summary = Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ');
    const lead = habits.length === 0 ? `No habits for ${date}.` : `${habits.length} habits for ${date}: ${summary}.`;
    return withNote(jsonResult({ user_timezone: tz, date, total: habits.length, counts, habits }, lead), note);
  },
};

// ---------------------------------------------------------------------------
// list_issues
// ---------------------------------------------------------------------------

export const ISSUES_DEFAULT_LIMIT = 10;
export const ISSUES_MAX_LIMIT = 100;
const BODY_PREVIEW = 500;
// Never pass on keys that work as credentials (a healthcheck's ping URL lets
// anyone ping it).
const HIDDEN_DETAIL = /ping_url|token|secret|password|api_?key/i;

function issueDetails(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (HIDDEN_DETAIL.test(key)) continue;
    if (['labels', 'assignees', 'milestone', 'closed_at'].includes(key)) continue;
    out[key] = typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  return out;
}

export function listIssues(db, { state = 'open', source, limit = ISSUES_DEFAULT_LIMIT, tz }) {
  const src = sourceClause(source);
  const sources = db.prepare(`SELECT DISTINCT source FROM issues WHERE state = ?${src.sql} ORDER BY source`)
    .all(state, ...src.params).map(r => r.source);
  const order = state === 'closed' ? "json_extract(metadata, '$.closed_at') DESC, opened_at DESC" : 'opened_at DESC';
  const groups = sources.map(name => {
    const total = db.prepare('SELECT COUNT(*) AS n FROM issues WHERE state = ? AND source = ?').get(state, name).n;
    const rows = db.prepare(`
      SELECT id, title, state, opened_at, url, body, metadata, source
      FROM issues WHERE state = ? AND source = ?
      ORDER BY ${order}, id
      LIMIT ?
    `).all(state, name, limit);
    const issues = rows.map(row => {
      let meta = {};
      try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
      const body = row.body ? String(row.body) : null;
      return {
        id: row.id,
        number: String(row.id).split(':').pop(),
        title: row.title,
        state: row.state,
        opened_at: formatInstant(row.opened_at, tz),
        closed_at: meta.closed_at ? formatInstant(meta.closed_at, tz) : null,
        url: row.url ?? null,
        labels: Array.isArray(meta.labels) ? meta.labels : [],
        assignees: Array.isArray(meta.assignees) ? meta.assignees : [],
        milestone: meta.milestone ?? null,
        details: issueDetails(meta),
        body_preview: body ? (body.length > BODY_PREVIEW ? `${body.slice(0, BODY_PREVIEW)}…` : body) : null,
      };
    });
    return { source: name, total, returned: issues.length, has_more: issues.length < total, issues };
  });
  return {
    state,
    total: groups.reduce((n, g) => n + g.total, 0),
    returned: groups.reduce((n, g) => n + g.returned, 0),
    limit_per_source: limit,
    sources: groups,
  };
}

const listIssuesTool = {
  name: 'list_issues',
  kind: 'read',
  pluginType: 'issues',
  description: 'List open (or recently closed) issues from every issues plugin, grouped by source: healthchecks that are down, Sentry errors, GitHub issues and the like (like bin/issues open). Each source shows its newest issues up to limit, with its total.',
  inputSchema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['open', 'closed'], description: 'open (default) or closed' },
      source: SOURCE_PROP,
      limit: { type: 'number', description: `Most issues per source (default ${ISSUES_DEFAULT_LIMIT}, maximum ${ISSUES_MAX_LIMIT})` },
    },
  },
  handler: async (args = {}, ctx = {}) => {
    const state = args.state || 'open';
    if (!['open', 'closed'].includes(state)) return errorResult('state must be open or closed');
    const tz = getConfiguredTimezone();
    const note = await freshen(ctx, 'issues', 'issues');
    const limit = clampInt(args.limit, ISSUES_DEFAULT_LIMIT, 1, ISSUES_MAX_LIMIT);
    const result = listIssues(ctx.db, { state, source: args.source, limit, tz });
    const lead = result.total === 0
      ? `No ${state} issues.`
      : `${result.total} ${state} issue${result.total === 1 ? '' : 's'} across ${result.sources.length} source${result.sources.length === 1 ? '' : 's'}` +
        (result.returned < result.total ? `; showing ${result.returned} (at most ${limit} per source).` : '.');
    return withNote(jsonResult({ user_timezone: tz, ...result }, lead), note);
  },
};

// ---------------------------------------------------------------------------
// search_tasks
// ---------------------------------------------------------------------------

export const SEARCH_TASKS_DEFAULT_LIMIT = 100;
export const SEARCH_TASKS_MAX_LIMIT = 500;

const PRIORITY_ORDER = `CASE priority
          WHEN 'highest' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          WHEN 'lowest' THEN 5
          ELSE 6
        END`;

/**
 * Tasks by title words, topic, creation date, source, stage and priority,
 * paged like list_tasks.
 */
export function searchTasks(db, args = {}, { today = getTodayDate() } = {}) {
  const conditions = [];
  const params = [];

  const status = args.status || 'open';
  if (status === 'open') conditions.push("status = 'open'");
  else if (status === 'completed') conditions.push("status IN ('completed', 'done')");

  if (args.query) {
    // Every word must appear somewhere in the title.
    for (const word of String(args.query).trim().split(/\s+/).filter(Boolean)) {
      conditions.push("title LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(word)}%`);
    }
  }
  if (args.topic) {
    const topic = String(args.topic).trim().replace(/^#?topic\//, '').replace(/^#/, '');
    conditions.push("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.topics') END) WHERE value = ?)");
    params.push(topic);
  }
  let createdSince = null;
  if (args.created_within_days !== undefined && args.created_within_days !== null) {
    const days = clampInt(args.created_within_days, 7, 0, 3650);
    createdSince = addDays(today, -days);
    conditions.push("json_extract(metadata, '$.created_date') >= ? AND json_extract(metadata, '$.created_date') <= ?");
    params.push(createdSince, today);
  }
  if (args.source) {
    conditions.push("source LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(args.source)}%`);
  }
  if (args.stage) {
    conditions.push("json_extract(metadata, '$.stage') = ?");
    params.push(args.stage);
  }
  if (args.priority) {
    conditions.push('priority = ?');
    params.push(args.priority);
  }
  if (args.today_only) {
    conditions.push("(due_date <= ? OR json_extract(metadata, '$.scheduled_date') <= ?)");
    params.push(today, today);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = createdSince
    ? `json_extract(metadata, '$.created_date') DESC, ${PRIORITY_ORDER}, id`
    : `${PRIORITY_ORDER}, due_date NULLS LAST, id`;
  const limit = args.limit ? clampInt(args.limit, SEARCH_TASKS_DEFAULT_LIMIT, 1, SEARCH_TASKS_MAX_LIMIT) : SEARCH_TASKS_DEFAULT_LIMIT;
  const offset = clampInt(args.offset ?? 0, 0, 0, Number.MAX_SAFE_INTEGER);

  const read = db.transaction(() => {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM tasks ${where}`).get(...params).n;
    const rows = db.prepare(`
      SELECT id, title, status, priority, due_date, metadata, source
      FROM tasks ${where}
      ORDER BY ${order}
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
    ...(createdSince ? { created_since: createdSince } : {}),
    tasks,
  };
}

export function searchTasksLead(result) {
  if (result.has_more) {
    return `Showing tasks ${result.offset + 1}-${result.offset + result.returned} of ${result.total}. More exist: call search_tasks again with offset: ${result.next_offset} (and the same filters) for the next page.`;
  }
  if (result.offset > 0) {
    return `Showing tasks ${result.returned === 0 ? 'none' : `${result.offset + 1}-${result.offset + result.returned}`} of ${result.total}. This is the last page.`;
  }
  return `Showing all ${result.total} matching tasks.`;
}

const searchTasksTool = {
  name: 'search_tasks',
  kind: 'read',
  pluginType: 'tasks',
  description: 'Search tasks by words in the title, topic, how recently they were created, source, stage, priority or status (like bin/tasks search, recent and list --topic). Pages like list_tasks: the reply says the total and the offset for the next page.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words that must all appear in the title (case-insensitive)' },
      topic: { type: 'string', description: 'A topic, such as "health" or "#topic/health"' },
      created_within_days: { type: 'number', description: 'Only tasks created in the last N days (by their ➕ date); sorts newest first' },
      status: { type: 'string', enum: ['open', 'completed', 'all'], description: 'open (default), completed or all' },
      source: SOURCE_PROP,
      stage: { type: 'string', enum: ['front-stage', 'back-stage', 'off-stage'], description: 'Only tasks of this stage' },
      priority: { type: 'string', enum: ['highest', 'high', 'medium', 'low', 'lowest'], description: 'Only tasks of this priority' },
      today_only: { type: 'boolean', description: 'Only tasks due or scheduled today or earlier' },
      limit: { type: 'number', description: `Most tasks to return (default ${SEARCH_TASKS_DEFAULT_LIMIT}, maximum ${SEARCH_TASKS_MAX_LIMIT})` },
      offset: { type: 'number', description: 'Tasks to skip, for the next page (default 0)' },
    },
  },
  handler: async (args = {}, ctx = {}) => {
    if (args.status && !['open', 'completed', 'all'].includes(args.status)) {
      return errorResult('status must be open, completed or all');
    }
    const tz = getConfiguredTimezone();
    const note = await freshen(ctx, 'tasks', 'tasks');
    const result = searchTasks(ctx.db, args, { today: getTodayDate(tz) });
    return withNote(jsonResult({ user_timezone: tz, ...result }, searchTasksLead(result)), note);
  },
};

export const tools = [getPlan, timerStatus, listTimeEntriesTool, habitsToday, listIssuesTool, searchTasksTool];
