/**
 * Diary reads (issue #686): list_diary, from the `diary` table the diary
 * plugins sync (what `bin/diary today`, `week`, `recent`, `search` and
 * `on-this-day` read).
 *
 * Markdown diary entries are stored as local wall time ("2026-11-01T09:30:00");
 * Day One entries carry a UTC instant ("2026-11-02T01:30:00Z"). Each entry's
 * day is worked out in the configured zone, so a late-evening Day One entry
 * lands on the day it was written rather than the next UTC day.
 */

import { jsonResult, errorResult } from '../mcp-safeguards.js';
import {
  getConfiguredTimezone, clampInt, todayIn, isDay, addDays, toLocal, cap,
  parseJson, likeTerm, isMissingTable, freshen, lead,
} from './_medium-reads-helpers.js';

export const RANGES = ['today', 'week', 'recent', 'on_this_day'];
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const TEXT_MAX_CHARS = 2000;

function sourceClause(args, where, params) {
  if (args.source) {
    where.push("source LIKE ? ESCAPE '\\'");
    params.push(likeTerm(args.source));
  }
}

function entryRecord(row, tz, maxChars) {
  const meta = parseJson(row.metadata, {});
  const local = toLocal(row.date, tz);
  const text = cap(row.text, maxChars);
  const out = {
    id: row.id,
    date: local.day,
    // Markdown sections with no timestamp are stored at a naive midnight.
    time: local.iso && !/T00:00:00$/.test(String(row.date)) ? local.iso : null,
    type: meta.type || null,
    text: text.text,
    truncated: text.truncated,
    source: row.source,
  };
  if (meta.role) out.role = meta.role;
  if (meta.starred) out.starred = true;
  if (meta.location?.localityName) out.location = meta.location.localityName;
  if (Array.isArray(meta.tags) && meta.tags.length) out.tags = meta.tags;
  return out;
}

/** Rows whose local day is in [first, last], from a slightly wider SQL window. */
function rowsForDays(db, args, first, last, tz) {
  const where = ['substr(date, 1, 10) >= ?', 'substr(date, 1, 10) <= ?'];
  const params = [addDays(first, -1), addDays(last, 1)];
  sourceClause(args, where, params);
  if (args.query) {
    where.push("text LIKE ? ESCAPE '\\'");
    params.push(likeTerm(args.query));
  }
  const rows = db.prepare(`
    SELECT id, date, text, metadata, source FROM diary
    WHERE ${where.join(' AND ')}
    ORDER BY date DESC, id
  `).all(...params);
  return rows.filter(r => {
    const day = toLocal(r.date, tz).day;
    return day >= first && day <= last;
  });
}

function rowsOnThisDay(db, args, day, tz) {
  const monthDays = [addDays(day, -1), day, addDays(day, 1)].map(d => d.slice(5));
  const where = [`substr(date, 6, 5) IN (${monthDays.map(() => '?').join(', ')})`, 'substr(date, 1, 4) < ?'];
  const params = [...monthDays, String(Number(day.slice(0, 4)) + 1)];
  sourceClause(args, where, params);
  if (args.query) {
    where.push("text LIKE ? ESCAPE '\\'");
    params.push(likeTerm(args.query));
  }
  const rows = db.prepare(`
    SELECT id, date, text, metadata, source FROM diary
    WHERE ${where.join(' AND ')}
    ORDER BY date DESC, id
  `).all(...params);
  return rows.filter(r => {
    const local = toLocal(r.date, tz).day;
    return local.slice(5) === day.slice(5) && local.slice(0, 4) < day.slice(0, 4);
  });
}

function rowsRecent(db, args, fetchLimit) {
  const where = [];
  const params = [];
  sourceClause(args, where, params);
  if (args.query) {
    where.push("text LIKE ? ESCAPE '\\'");
    params.push(likeTerm(args.query));
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM diary ${whereClause}`).get(...params).n;
  const rows = db.prepare(`
    SELECT id, date, text, metadata, source FROM diary ${whereClause}
    ORDER BY date DESC, id LIMIT ?
  `).all(...params, fetchLimit);
  return { total, rows };
}

export async function listDiary(args, ctx) {
  const tz = getConfiguredTimezone();
  const now = ctx.now ?? new Date();
  const today = todayIn(tz, now);
  if (args.date !== undefined && !isDay(args.date)) return errorResult('date must be YYYY-MM-DD');
  if (args.range !== undefined && !RANGES.includes(args.range)) return errorResult(`range must be one of ${RANGES.join(', ')}`);
  const query = args.query ? String(args.query).trim() : '';
  const queryArgs = { ...args, query };
  const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxChars = clampInt(args.max_chars, TEXT_MAX_CHARS, 200, 20000);

  // What to show: an explicit range wins; then a date; a query alone searches
  // everything (bin/diary search); nothing at all means today.
  let range = args.range;
  if (!range) range = args.date ? 'day' : (query ? 'search' : 'today');
  const day = args.date || today;

  const note = await freshen(ctx, 'diary', 'diary');

  let rows;
  let total;
  let label;
  try {
    if (range === 'today' || range === 'day') {
      rows = rowsForDays(ctx.db, queryArgs, day, day, tz);
      label = `on ${day}`;
    } else if (range === 'week') {
      // bin/diary week: the seven days before the day, and the day itself.
      const first = addDays(day, -7);
      rows = rowsForDays(ctx.db, queryArgs, first, day, tz);
      label = `from ${first} through ${day}`;
    } else if (range === 'on_this_day') {
      rows = rowsOnThisDay(ctx.db, queryArgs, day, tz);
      label = `on ${day.slice(5)} in years before ${day.slice(0, 4)}`;
    } else {
      const recent = rowsRecent(ctx.db, queryArgs, limit);
      rows = recent.rows;
      total = recent.total;
      label = range === 'search' ? 'in the whole diary' : 'most recent';
    }
  } catch (error) {
    if (isMissingTable(error)) return jsonResult({ user_timezone: tz, total: 0, entries: [] }, 'No diary entries have been synced yet.');
    throw error;
  }
  if (total === undefined) total = rows.length;
  const page = rows.slice(0, limit);
  const entries = page.map(r => entryRecord(r, tz, maxChars));
  const byType = {};
  for (const e of entries) byType[e.type || 'entry'] = (byType[e.type || 'entry'] || 0) + 1;

  const matching = query ? ` matching "${query}"` : '';
  const text = total === 0
    ? `No diary entries${matching} ${label}.`
    : `${total} diary entr${total === 1 ? 'y' : 'ies'}${matching} ${label}${entries.length < total ? `; showing the newest ${entries.length} (raise limit for more)` : ''}.`;
  return jsonResult({
    user_timezone: tz,
    range,
    date: range === 'search' || range === 'recent' ? null : day,
    query: query || null,
    total,
    returned: entries.length,
    limit,
    has_more: entries.length < total,
    by_type: byType,
    entries,
  }, lead(text, note));
}

export const tools = [
  {
    name: 'list_diary',
    kind: 'read',
    pluginType: 'diary',
    description: 'Diary entries (like bin/diary today, week, recent, search and on-this-day): gratitude, progress, concern, journal and role entries, with their type, day and time. With no arguments, today\'s entries.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'A day (YYYY-MM-DD). Alone, that day\'s entries; with range, the day the range is counted from.' },
        range: { type: 'string', enum: RANGES, description: 'today (default), week (the 7 days before and the day), recent (newest entries), on_this_day (the same date in earlier years).' },
        query: { type: 'string', description: 'Only entries containing this text. Alone, searches the whole diary.' },
        source: { type: 'string', description: 'Only this diary source (name contains this).' },
        limit: { type: 'number', description: `Max entries (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        max_chars: { type: 'number', description: `Cut each entry's text at this length (default ${TEXT_MAX_CHARS}).` },
      },
    },
    handler: listDiary,
  },
];
