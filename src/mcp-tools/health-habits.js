/**
 * Health and habit reads (issue #686):
 *   - health_today, health_summary: the `health_metrics` table (what
 *     `bin/health today`, `summary` and `metric <name>` read).
 *   - habit_streaks, habit_history: the `habits` table (what `bin/habits
 *     streaks` and `history <habit>` read).
 * Both tables are keyed by local calendar date (YYYY-MM-DD).
 */

import { jsonResult, errorResult } from '../mcp-safeguards.js';
import { METRIC_DISPLAY } from '../health-metrics.js';
import {
  getConfiguredTimezone, clampInt, todayIn, isDay, addDays, parseJson,
  likeTerm, isMissingTable, freshen, lead,
} from './_medium-reads-helpers.js';

// The metrics bin/health today and summary lead with.
export const KEY_METRICS = [
  'step_count',
  'active_energy',
  'apple_exercise_time',
  'sleep_analysis',
  'weight_body_mass',
  'resting_heart_rate',
  'heart_rate_variability_sdnn',
];

function display(name, value) {
  const d = METRIC_DISPLAY[name];
  if (!d || value === null || value === undefined) return { label: d?.label || name, formatted: null };
  try {
    return { label: d.label, formatted: String(d.format(Number(value))) };
  } catch {
    return { label: d.label, formatted: null };
  }
}

function round(n, places = 2) {
  if (n === null || n === undefined) return null;
  const f = 10 ** places;
  return Math.round(Number(n) * f) / f;
}

function sourceClause(args, where, params) {
  if (args.source) {
    where.push("source LIKE ? ESCAPE '\\'");
    params.push(likeTerm(args.source));
  }
}

function sortKeyFirst(a, b) {
  const ia = KEY_METRICS.indexOf(a);
  const ib = KEY_METRICS.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.localeCompare(b);
}

const NO_HEALTH = 'No health data has been synced yet.';

export async function healthToday(args, ctx) {
  const tz = getConfiguredTimezone();
  if (args.date !== undefined && !isDay(args.date)) return errorResult('date must be YYYY-MM-DD');
  const date = args.date || todayIn(tz, ctx.now ?? new Date());
  const note = await freshen(ctx, 'health', 'health');

  const where = ['date = ?'];
  const params = [date];
  sourceClause(args, where, params);
  let rows;
  try {
    rows = ctx.db.prepare(`
      SELECT metric_name, value, units, source FROM health_metrics
      WHERE ${where.join(' AND ')} ORDER BY metric_name, source
    `).all(...params);
  } catch (error) {
    if (isMissingTable(error)) return jsonResult({ user_timezone: tz, date, metrics: [] }, NO_HEALTH);
    throw error;
  }

  const all = rows
    .map(r => ({ metric: r.metric_name, ...display(r.metric_name, r.value), value: round(r.value), units: r.units || null, key: KEY_METRICS.includes(r.metric_name), source: r.source }))
    .sort((a, b) => sortKeyFirst(a.metric, b.metric));
  const metrics = args.all ? all : all.filter(m => m.key);
  const otherNames = [...new Set(all.filter(m => !m.key).map(m => m.metric))];

  const text = rows.length === 0
    ? `No health metrics recorded for ${date}.`
    : `${metrics.length} ${args.all ? '' : 'key '}health metric(s) for ${date}${!args.all && otherNames.length ? `; ${otherNames.length} other metric(s) have data (pass all: true to include them)` : ''}.`;
  return jsonResult({
    user_timezone: tz,
    date,
    metrics,
    other_metrics: args.all ? undefined : otherNames,
  }, lead(text, note));
}

/** Resolve a metric argument to one stored metric name, or candidates. */
function resolveMetric(db, wanted) {
  const exact = db.prepare('SELECT DISTINCT metric_name FROM health_metrics WHERE LOWER(metric_name) = LOWER(?)').all(wanted);
  if (exact.length === 1) return { name: exact[0].metric_name };
  const label = Object.entries(METRIC_DISPLAY).filter(([, d]) => d.label.toLowerCase() === wanted.toLowerCase()).map(([k]) => k);
  const like = db.prepare("SELECT DISTINCT metric_name FROM health_metrics WHERE metric_name LIKE ? ESCAPE '\\' ORDER BY metric_name")
    .all(likeTerm(wanted.replace(/\s+/g, '_'))).map(r => r.metric_name);
  const candidates = [...new Set([...label, ...like])];
  const present = new Set(db.prepare('SELECT DISTINCT metric_name FROM health_metrics').all().map(r => r.metric_name));
  const stored = candidates.filter(c => present.has(c));
  if (stored.length === 1) return { name: stored[0] };
  return { candidates: stored, available: [...present].sort() };
}

export async function healthSummary(args, ctx) {
  const tz = getConfiguredTimezone();
  const today = todayIn(tz, ctx.now ?? new Date());
  const note = await freshen(ctx, 'health', 'health');

  try {
    if (args.metric) {
      const days = clampInt(args.days, 14, 1, 366);
      const found = resolveMetric(ctx.db, String(args.metric).trim());
      if (!found.name) {
        const msg = found.candidates.length > 1
          ? `"${args.metric}" matches several metrics: ${found.candidates.join(', ')}. Pass one of them.`
          : `No metric matches "${args.metric}". Metrics with data: ${found.available.slice(0, 40).join(', ') || 'none'}.`;
        return errorResult(msg);
      }
      const first = addDays(today, -(days - 1));
      const where = ['metric_name = ?', 'date >= ?', 'date <= ?'];
      const params = [found.name, first, today];
      sourceClause(args, where, params);
      const rows = ctx.db.prepare(`
        SELECT date, value, units, source FROM health_metrics
        WHERE ${where.join(' AND ')} ORDER BY date DESC, source
      `).all(...params);
      const values = rows.map(r => Number(r.value));
      const label = display(found.name, null).label;
      const stats = values.length
        ? { average: round(values.reduce((a, b) => a + b, 0) / values.length), min: round(Math.min(...values)), max: round(Math.max(...values)) }
        : null;
      return jsonResult({
        user_timezone: tz,
        metric: found.name,
        label,
        from: first,
        to: today,
        days,
        count: rows.length,
        stats,
        history: rows.map(r => ({ date: r.date, value: round(r.value), formatted: display(found.name, r.value).formatted, units: r.units || null, source: r.source })),
      }, lead(rows.length
        ? `${label}: ${rows.length} reading(s) from ${first} through ${today}, newest first.`
        : `No ${label} readings from ${first} through ${today}.`, note));
    }

    const days = clampInt(args.days, 7, 1, 366);
    const first = addDays(today, -(days - 1));
    const where = ['date >= ?', 'date <= ?'];
    const params = [first, today];
    sourceClause(args, where, params);
    const rows = ctx.db.prepare(`
      SELECT metric_name, AVG(value) AS avg_value, MIN(value) AS min_value, MAX(value) AS max_value,
             COUNT(*) AS count, COUNT(DISTINCT date) AS days_with_data, MAX(units) AS units
      FROM health_metrics WHERE ${where.join(' AND ')}
      GROUP BY metric_name
    `).all(...params);
    const all = rows
      .map(r => ({
        metric: r.metric_name,
        label: display(r.metric_name, null).label,
        average: round(r.avg_value),
        average_formatted: display(r.metric_name, r.avg_value).formatted,
        min: round(r.min_value),
        max: round(r.max_value),
        units: r.units || null,
        days_with_data: r.days_with_data,
        key: KEY_METRICS.includes(r.metric_name),
      }))
      .sort((a, b) => sortKeyFirst(a.metric, b.metric));
    const metrics = args.all ? all : all.filter(m => m.key);
    const otherNames = all.filter(m => !m.key).map(m => m.metric);
    return jsonResult({
      user_timezone: tz,
      from: first,
      to: today,
      days,
      metrics,
      other_metrics: args.all ? undefined : otherNames,
    }, lead(rows.length
      ? `Health summary for ${first} through ${today}: ${metrics.length} ${args.all ? '' : 'key '}metric(s)${!args.all && otherNames.length ? ` (${otherNames.length} more with all: true, or one with metric)` : ''}.`
      : `No health metrics from ${first} through ${today}.`, note));
  } catch (error) {
    if (isMissingTable(error)) return jsonResult({ user_timezone: tz, metrics: [] }, NO_HEALTH);
    throw error;
  }
}

const NO_HABITS = 'No habits have been synced yet.';

export async function habitStreaks(args, ctx) {
  const tz = getConfiguredTimezone();
  const today = todayIn(tz, ctx.now ?? new Date());
  const min = clampInt(args.min, 1, 0, 100000);
  const note = await freshen(ctx, 'habits', 'habits');

  try {
    // Streaks live in each day's row metadata; read the newest day on or
    // before today (today's rows may not exist yet early in the day).
    const dayWhere = ['date <= ?'];
    const dayParams = [today];
    sourceClause(args, dayWhere, dayParams);
    const asOf = ctx.db.prepare(`SELECT MAX(date) AS d FROM habits WHERE ${dayWhere.join(' AND ')}`).get(...dayParams).d;
    if (!asOf) return jsonResult({ user_timezone: tz, as_of: null, total: 0, streaks: [] }, lead('No habit data on or before today.', note));

    const where = ['date = ?'];
    const params = [asOf];
    sourceClause(args, where, params);
    if (args.habit) {
      where.push("title LIKE ? ESCAPE '\\'");
      params.push(likeTerm(args.habit));
    }
    const rows = ctx.db.prepare(`
      SELECT habit_id, title, category, status, metadata, source FROM habits
      WHERE ${where.join(' AND ')}
    `).all(...params);
    const streaks = rows
      .map(r => {
        const meta = parseJson(r.metadata, {});
        return {
          habit_id: r.habit_id,
          title: r.title,
          category: r.category || null,
          streak: Number(meta.current_streak) || 0,
          status_on_as_of: r.status,
          source: r.source,
        };
      })
      .filter(s => s.streak >= min)
      .sort((a, b) => b.streak - a.streak || a.title.localeCompare(b.title));

    const asOfNote = asOf === today ? '' : ` (as of ${asOf}, the newest synced day)`;
    const text = streaks.length === 0
      ? `No habit has a streak of ${min}+ day(s)${asOfNote}.`
      : `${streaks.length} habit(s) with a streak of ${min}+ day(s)${asOfNote}.`;
    return jsonResult({ user_timezone: tz, as_of: asOf, min, total: streaks.length, streaks }, lead(text, note));
  } catch (error) {
    if (isMissingTable(error)) return jsonResult({ user_timezone: tz, streaks: [] }, NO_HABITS);
    throw error;
  }
}

export async function habitHistory(args, ctx) {
  const wanted = String(args.habit ?? '').trim();
  if (!wanted) return errorResult('habit is required');
  const tz = getConfiguredTimezone();
  const today = todayIn(tz, ctx.now ?? new Date());
  const days = clampInt(args.days, 14, 1, 366);
  const note = await freshen(ctx, 'habits', 'habits');

  try {
    const srcWhere = [];
    const srcParams = [];
    sourceClause(args, srcWhere, srcParams);
    const and = srcWhere.length ? ` AND ${srcWhere.join(' AND ')}` : '';
    let matches = ctx.db.prepare(`SELECT DISTINCT habit_id, title FROM habits WHERE LOWER(title) = LOWER(?)${and}`).all(wanted, ...srcParams);
    if (matches.length === 0) {
      matches = ctx.db.prepare(`SELECT DISTINCT habit_id, title FROM habits WHERE title LIKE ? ESCAPE '\\'${and} ORDER BY title`).all(likeTerm(wanted), ...srcParams);
    }
    const ids = [...new Set(matches.map(m => m.habit_id))];
    if (ids.length === 0) return errorResult(`No habit matches "${wanted}".`);
    if (ids.length > 1) {
      const titles = [...new Set(matches.map(m => m.title))];
      return errorResult(`"${wanted}" matches ${ids.length} habits: ${titles.slice(0, 20).join('; ')}. Pass a fuller title.`);
    }

    const first = addDays(today, -(days - 1));
    const rows = ctx.db.prepare(`
      SELECT date, title, status, value, goal_type, metadata, source FROM habits
      WHERE habit_id = ? AND date >= ? AND date <= ?${and}
      ORDER BY date DESC
    `).all(ids[0], first, today, ...srcParams);

    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    const latestMeta = parseJson(rows[0]?.metadata, {});
    const history = rows.map(r => {
      const meta = parseJson(r.metadata, {});
      return {
        date: r.date,
        status: r.status,
        value: r.value ?? null,
        target_type: meta.target_type ?? null,
        target_value: meta.target_value ?? null,
      };
    });
    const title = rows[0]?.title || matches[0].title;
    return jsonResult({
      user_timezone: tz,
      habit_id: ids[0],
      title,
      goal_type: rows[0]?.goal_type ?? null,
      from: first,
      to: today,
      days,
      current_streak: latestMeta.current_streak !== undefined ? Number(latestMeta.current_streak) || 0 : null,
      counts,
      history,
    }, lead(rows.length
      ? `${title}: ${rows.length} day(s) recorded from ${first} through ${today}, newest first.`
      : `${title}: nothing recorded from ${first} through ${today}.`, note));
  } catch (error) {
    if (isMissingTable(error)) return jsonResult({ user_timezone: tz, history: [] }, NO_HABITS);
    throw error;
  }
}

const sourceProp = { type: 'string', description: 'Only this source (name contains this).' };

export const tools = [
  {
    name: 'health_today',
    kind: 'read',
    pluginType: 'health',
    description: 'Key health metrics for a day (like bin/health today): steps, active calories, exercise, sleep, weight, resting heart rate, HRV. Pass all: true for every metric recorded that day.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Day (YYYY-MM-DD), default today.' },
        all: { type: 'boolean', description: 'Include every metric, not only the key ones.' },
        source: sourceProp,
      },
    },
    handler: healthToday,
  },
  {
    name: 'health_summary',
    kind: 'read',
    pluginType: 'health',
    description: 'Health over several days (like bin/health summary): average, min and max of the key metrics. With metric, one metric\'s day-by-day history instead (like bin/health metric <name>).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days back, today included (default 7 for the summary, 14 for one metric; max 366).' },
        metric: { type: 'string', description: 'One metric, by stored name (resting_heart_rate) or label (Resting HR).' },
        all: { type: 'boolean', description: 'Summary of every metric, not only the key ones.' },
        source: sourceProp,
      },
    },
    handler: healthSummary,
  },
  {
    name: 'habit_streaks',
    kind: 'read',
    pluginType: 'habits',
    description: 'Current habit streaks (like bin/habits streaks), longest first, as of today or the newest synced day.',
    inputSchema: {
      type: 'object',
      properties: {
        min: { type: 'number', description: 'Only streaks at least this long (default 1; 0 lists every habit).' },
        habit: { type: 'string', description: 'Only habits whose title contains this.' },
        source: sourceProp,
      },
    },
    handler: habitStreaks,
  },
  {
    name: 'habit_history',
    kind: 'read',
    pluginType: 'habits',
    description: 'One habit\'s day-by-day status (like bin/habits history <habit>): completed, pending, skipped or partial, with values, plus counts and the current streak.',
    inputSchema: {
      type: 'object',
      properties: {
        habit: { type: 'string', description: 'The habit\'s title, or a distinctive part of it.' },
        days: { type: 'number', description: 'Days back, today included (default 14, max 366).' },
        source: sourceProp,
      },
      required: ['habit'],
    },
    handler: habitHistory,
  },
];
