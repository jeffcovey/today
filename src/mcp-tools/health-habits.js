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
  likeTerm, isMissingTable, freshen, lead, exact,
} from './_medium-reads-helpers.js';

// The metrics bin/health today and summary lead with.
export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 1000;
export const STREAKS_DEFAULT_LIMIT = 50;
export const STREAKS_MAX_LIMIT = 500;

export const KEY_METRICS = [
  'step_count',
  'active_energy',
  'apple_exercise_time',
  'sleep_analysis',
  'weight_body_mass',
  'resting_heart_rate',
  'heart_rate_variability_sdnn',
];

// METRIC_DISPLAY labels each value with a fixed unit (lbs, mi, L, bpm...),
// but the value is stored in whatever unit the source exported (70 kg stays
// 70, units "kg"; 500 mL stays 500, units "mL"). The formatter's unit is used
// only when the stored unit is one of its spellings below, or the same word;
// otherwise the value is shown with the unit it was stored in.
const DISPLAY_UNITS = {
  lbs: /^(lb|lbs|pound|pounds)$/i,
  mi: /^(mi|mile|miles)$/i,
  in: /^(in|inch|inches)$/i,
  mph: /^(mph|mi\/h|mi\/hr)$/i,
  kcal: /^(kcal|cal|kilocalories?)$/i,
  min: /^(min|mins|minutes?)$/i,
  hrs: /^(h|hr|hrs|hours?)$/i,
  bpm: /^(bpm|count\/min|beats\/min)$/i,
  '/min': /^(\/min|count\/min|breaths\/min)$/i,
  ms: /^(ms|milliseconds?)$/i,
  dB: /^(db|dbaspl|dbspl|db\s?spl)$/i,
  L: /^(l|liters?|litres?)$/i,
  mg: /^mg$/i,
  mcg: /^(mcg|µg|μg|ug)$/i,
  g: /^(g|grams?)$/i,
  drinks: /^(drinks?|count)$/i,
  '%': /^(%|percent)$/i,
};

function storedUnitFits(shown, stored) {
  const known = DISPLAY_UNITS[shown];
  return known ? known.test(stored) : shown.toLowerCase() === stored.toLowerCase();
}

function display(name, value, units = null) {
  const d = METRIC_DISPLAY[name];
  if (!d || value === null || value === undefined) return { label: d?.label || name, formatted: null };
  let formatted;
  try {
    formatted = String(d.format(Number(value)));
  } catch {
    return { label: d.label, formatted: null };
  }
  // The formatter's unit: the last word after a space, or a glued-on %.
  const m = / (\S+)$|\d(%)$/.exec(formatted);
  const shown = m ? (m[1] ?? m[2]) : null;
  const stored = units ? String(units).trim() : '';
  if (stored && shown && !storedUnitFits(shown, stored)) {
    const v = Number(value);
    formatted = `${Math.abs(v) >= 1 ? round(v, 1) : Number(v.toPrecision(3))} ${stored}`;
  }
  return { label: d.label, formatted };
}

/** Rounding for display text only; machine-readable fields use exact(). */
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
    .map(r => ({ metric: r.metric_name, ...display(r.metric_name, r.value, r.units), value: exact(r.value), units: r.units || null, key: KEY_METRICS.includes(r.metric_name), source: r.source }))
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

/**
 * Resolve a metric argument to one stored metric name, or candidates. Only
 * metrics the source filter (if any) keeps are considered, so a metric that
 * exists only in another source neither matches nor makes the name ambiguous.
 */
function resolveMetric(db, wanted, args = {}) {
  const srcWhere = [];
  const srcParams = [];
  sourceClause(args, srcWhere, srcParams);
  const and = srcWhere.length ? ` AND ${srcWhere.join(' AND ')}` : '';
  const exact = db.prepare(`SELECT DISTINCT metric_name FROM health_metrics WHERE LOWER(metric_name) = LOWER(?)${and}`).all(wanted, ...srcParams);
  if (exact.length === 1) return { name: exact[0].metric_name };
  const label = Object.entries(METRIC_DISPLAY).filter(([, d]) => d.label.toLowerCase() === wanted.toLowerCase()).map(([k]) => k);
  const like = db.prepare(`SELECT DISTINCT metric_name FROM health_metrics WHERE metric_name LIKE ? ESCAPE '\\'${and} ORDER BY metric_name`)
    .all(likeTerm(wanted.replace(/\s+/g, '_')), ...srcParams).map(r => r.metric_name);
  const candidates = [...new Set([...label, ...like])];
  const present = new Set(db.prepare(`SELECT DISTINCT metric_name FROM health_metrics${srcWhere.length ? ` WHERE ${srcWhere.join(' AND ')}` : ''}`)
    .all(...srcParams).map(r => r.metric_name));
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
      const limit = clampInt(args.limit, HISTORY_DEFAULT_LIMIT, 1, HISTORY_MAX_LIMIT);
      const found = resolveMetric(ctx.db, String(args.metric).trim(), args);
      if (!found.name) {
        const msg = found.candidates.length > 1
          ? `"${args.metric}" matches several metrics: ${found.candidates.join(', ')}. Pass one of them.`
          : `No metric matches "${args.metric}"${args.source ? ` in source "${args.source}"` : ''}. Metrics with data: ${found.available.slice(0, 40).join(', ') || 'none'}.`;
        // A sync that is still running may yet bring the metric in.
        return errorResult(lead(msg, note));
      }
      const first = addDays(today, -(days - 1));
      const where = ['metric_name = ?', 'date >= ?', 'date <= ?'];
      const params = [found.name, first, today];
      sourceClause(args, where, params);
      const rows = ctx.db.prepare(`
        SELECT date, value, units, source FROM health_metrics
        WHERE ${where.join(' AND ')} ORDER BY date DESC, source
      `).all(...params);
      const label = display(found.name, null).label;
      const page = rows.slice(0, limit);
      const statsOf = list => {
        const values = list.map(r => Number(r.value));
        return { average: exact(values.reduce((a, b) => a + b, 0) / values.length), min: exact(Math.min(...values)), max: exact(Math.max(...values)) };
      };
      // Readings in different units (kg from one source, lb from another)
      // are not averaged together.
      const unitList = [...new Set(rows.map(r => r.units || null))];
      const stats = rows.length && unitList.length === 1 ? statsOf(rows) : null;
      const statsByUnits = unitList.length > 1
        ? Object.fromEntries(unitList.map(u => [u ?? 'unknown', statsOf(rows.filter(r => (r.units || null) === u))]))
        : undefined;
      return jsonResult({
        user_timezone: tz,
        metric: found.name,
        label,
        from: first,
        to: today,
        days,
        // count and the stats cover every reading in the window; history is
        // the newest `limit` of them.
        count: rows.length,
        stats,
        stats_by_units: statsByUnits,
        returned: page.length,
        limit,
        has_more: page.length < rows.length,
        history: page.map(r => ({ date: r.date, value: exact(r.value), formatted: display(found.name, r.value, r.units).formatted, units: r.units || null, source: r.source })),
      }, lead(rows.length
        ? `${label}: ${rows.length} reading(s) from ${first} through ${today}, newest first${page.length < rows.length ? `; history shows the newest ${page.length} (raise limit, up to ${HISTORY_MAX_LIMIT}, or narrow days for more; the stats cover all of them)` : ''}.`
        : `No ${label} readings from ${first} through ${today}.`, note));
    }

    const days = clampInt(args.days, 7, 1, 366);
    const first = addDays(today, -(days - 1));
    const where = ['date >= ?', 'date <= ?'];
    const params = [first, today];
    sourceClause(args, where, params);
    const rows = ctx.db.prepare(`
      SELECT metric_name, AVG(value) AS avg_value, MIN(value) AS min_value, MAX(value) AS max_value,
             COUNT(*) AS count, COUNT(DISTINCT date) AS days_with_data, units
      FROM health_metrics WHERE ${where.join(' AND ')}
      GROUP BY metric_name, IFNULL(units, '')
    `).all(...params);
    const all = rows
      .map(r => ({
        metric: r.metric_name,
        label: display(r.metric_name, null).label,
        average: exact(r.avg_value),
        average_formatted: display(r.metric_name, r.avg_value, r.units).formatted,
        min: exact(r.min_value),
        max: exact(r.max_value),
        units: r.units || null,
        days_with_data: r.days_with_data,
        key: KEY_METRICS.includes(r.metric_name),
      }))
      .sort((a, b) => sortKeyFirst(a.metric, b.metric));
    const metrics = args.all ? all : all.filter(m => m.key);
    // A metric stored in two units has one entry per unit.
    const otherNames = [...new Set(all.filter(m => !m.key).map(m => m.metric))];
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
  const limit = clampInt(args.limit, STREAKS_DEFAULT_LIMIT, 1, STREAKS_MAX_LIMIT);
  const note = await freshen(ctx, 'habits', 'habits');

  try {
    // Streaks live in each day's row metadata; read each habit's newest row
    // on or before today. Today's rows may not exist yet early in the day, a
    // backup-based source can lag another by days, and a filtered sync can
    // bring one routine up to today while the rest of its source stays on an
    // older day.
    const dayWhere = ['date <= ?'];
    const dayParams = [today];
    sourceClause(args, dayWhere, dayParams);
    const where = [];
    const params = [...dayParams];
    if (args.habit) {
      where.push("h.title LIKE ? ESCAPE '\\'");
      params.push(likeTerm(args.habit));
    }
    const rows = ctx.db.prepare(`
      SELECT h.habit_id, h.title, h.category, h.status, h.metadata, h.source, h.date
      FROM habits h
      JOIN (
        SELECT source, habit_id, MAX(date) AS newest FROM habits
        WHERE ${dayWhere.join(' AND ')} GROUP BY source, habit_id
      ) n ON h.source = n.source AND h.habit_id = n.habit_id AND h.date = n.newest
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    `).all(...params);
    if (rows.length === 0) {
      return jsonResult({ user_timezone: tz, as_of: null, sources: [], min, limit, total: 0, returned: 0, has_more: false, streaks: [] },
        lead(args.habit ? `No habit matching "${args.habit}" has data on or before today.` : 'No habit data on or before today.', note));
    }
    const all = rows
      .map(r => {
        const meta = parseJson(r.metadata, {});
        return {
          habit_id: r.habit_id,
          title: r.title,
          category: r.category || null,
          streak: Number(meta.current_streak) || 0,
          status_on_as_of: r.status,
          as_of: r.date,
          source: r.source,
        };
      })
      .filter(s => s.streak >= min)
      .sort((a, b) => b.streak - a.streak || a.title.localeCompare(b.title));
    const streaks = all.slice(0, limit);

    // Each source's newest day among the habits read, and every habit row
    // older than today, grouped by source and day, for the freshness warning.
    const sourceMap = new Map();
    const behindMap = new Map();
    for (const r of rows) {
      const sd = sourceMap.get(r.source);
      if (!sd || r.date > sd.as_of) sourceMap.set(r.source, { source: r.source, as_of: r.date });
      if (r.date !== today) {
        const key = JSON.stringify([r.source, r.date]);
        const b = behindMap.get(key) || { source: r.source, as_of: r.date, habits: 0 };
        b.habits += 1;
        behindMap.set(key, b);
      }
    }
    const sourceDays = [...sourceMap.values()].sort((a, b) => a.source.localeCompare(b.source));
    const behind = [...behindMap.values()].sort((a, b) => a.source.localeCompare(b.source) || b.as_of.localeCompare(a.as_of));
    const asOf = sourceDays.reduce((max, sd) => (sd.as_of > max ? sd.as_of : max), sourceDays[0].as_of);
    const asOfNote = behind.length === 0
      ? ''
      : behind.length === 1 && behind[0].habits === rows.length
        ? ` (as of ${behind[0].as_of}, the newest synced day)`
        : ` (not every habit is synced through today: ${behind.map(b => `${b.habits} habit(s) in ${b.source} as of ${b.as_of}`).join('; ')}; each habit is read at its own newest synced day)`;
    const shown = streaks.length < all.length ? `; showing the longest ${streaks.length} (raise limit, up to ${STREAKS_MAX_LIMIT}, for the rest)` : '';
    const text = all.length === 0
      ? `No habit has a streak of ${min}+ day(s)${asOfNote}.`
      : `${all.length} habit(s) with a streak of ${min}+ day(s)${asOfNote}${shown}.`;
    return jsonResult({
      user_timezone: tz, as_of: asOf, sources: sourceDays, behind_today: behind, min, limit,
      total: all.length, returned: streaks.length, has_more: streaks.length < all.length, streaks,
    }, lead(text, note));
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
    let matches = ctx.db.prepare(`SELECT DISTINCT source, habit_id, title FROM habits WHERE LOWER(title) = LOWER(?)${and}`).all(wanted, ...srcParams);
    if (matches.length === 0) {
      matches = ctx.db.prepare(`SELECT DISTINCT source, habit_id, title FROM habits WHERE title LIKE ? ESCAPE '\\'${and} ORDER BY title`).all(likeTerm(wanted), ...srcParams);
    }
    // habit_id is only unique within a source, so a habit is the pair.
    const pairs = [...new Map(matches.map(m => [JSON.stringify([m.source, m.habit_id]), m])).values()];
    if (pairs.length === 0) return errorResult(lead(`No habit matches "${wanted}".`, note));
    if (pairs.length > 1) {
      const labels = [...new Set(pairs.map(m => `${m.title} (${m.source})`))];
      return errorResult(`"${wanted}" matches ${pairs.length} habits: ${labels.slice(0, 20).join('; ')}. Pass a fuller title, or source.`);
    }
    const { source: habitSource, habit_id: habitId } = pairs[0];

    const first = addDays(today, -(days - 1));
    const rows = ctx.db.prepare(`
      SELECT date, title, status, value, goal_type, metadata, source FROM habits
      WHERE source = ? AND habit_id = ? AND date >= ? AND date <= ?
      ORDER BY date DESC
    `).all(habitSource, habitId, first, today);

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
    const title = rows[0]?.title || pairs[0].title;
    return jsonResult({
      user_timezone: tz,
      habit_id: habitId,
      source: habitSource,
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
        limit: { type: 'number', description: `With metric: max readings in the history, newest first (default ${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT}); the stats cover every reading.` },
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
    description: 'Current habit streaks (like bin/habits streaks), longest first, each habit as of today or its newest synced day.',
    inputSchema: {
      type: 'object',
      properties: {
        min: { type: 'number', description: 'Only streaks at least this long (default 1; 0 lists every habit).' },
        limit: { type: 'number', description: `Max habits, longest streaks first (default ${STREAKS_DEFAULT_LIMIT}, max ${STREAKS_MAX_LIMIT}); total counts them all.` },
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
