/**
 * Calendar reads and time zone reporting for the MCP server.
 *
 * Timed events are stored as UTC ("2026-11-01T23:30:00Z") by google-calendar,
 * and some public-calendars feeds store a local time with no offset plus the
 * event's TZID in start_timezone. SQLite's date(start_date) compares UTC dates,
 * so a filter built on it puts evening events on the wrong day in a negative
 * offset and drops events that began before the day and are still running.
 *
 * These helpers pick events by overlap with the user's local days, in the
 * time zone configured in the vault's today.toml (the `timezone` key you
 * change when traveling), and return every time both in that zone with its
 * offset and in UTC, with the zone itself named.
 */

import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { getConfiguredTimezone, wallTimeInZone } from './date-utils.js';
import { isValidTimezone } from './timezone-resolver.js';

export const LIST_EVENTS_MAX_DAYS = 31;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Add whole days to a YYYY-MM-DD string, in UTC so DST can't shift it. */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function zoneOrDefault(tz) {
  return tz && isValidTimezone(tz) ? tz : getConfiguredTimezone();
}

/** Format an instant as ISO 8601 with the offset in `tz`. */
export function isoInZone(instant, tz) {
  return format(new TZDate(instant.getTime(), tz), "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/** The instant a local wall-clock time in `tz` names. */
export function wallTimeToInstant(wallTime, tz) {
  return wallTimeInZone(wallTime, tz);
}

/**
 * The instant a stored event time names, or null for a date-only value.
 * A value with Z or an offset is used as given; one without is read in the
 * event's own zone when it has one, else in the user's zone (a floating time).
 */
export function eventInstant(value, eventTz, userTz) {
  if (!value || DATE_ONLY.test(value)) return null;
  if (HAS_ZONE.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const tz = eventTz && isValidTimezone(eventTz) ? eventTz : userTz;
  const d = wallTimeToInstant(value.slice(0, 19), tz);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Where the user is, for the top of every read: their configured zone, its
 * current offset, the time now there, and today's date there.
 */
export function timeZoneInfo({ timezone, now = new Date() } = {}) {
  const tz = zoneOrDefault(timezone);
  const local = new TZDate(now.getTime(), tz);
  return {
    user_timezone: tz,
    utc_offset: format(local, 'xxx'),
    now: format(local, "yyyy-MM-dd'T'HH:mm:ssxxx"),
    today: format(local, 'yyyy-MM-dd'),
  };
}

export function timeZoneLine(info) {
  return `Times are in ${info.user_timezone} (UTC${info.utc_offset}), the user's configured time zone. ` +
    `Now: ${info.now}. Today: ${info.today}.`;
}

function normalizeDays(days) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, LIST_EVENTS_MAX_DAYS);
}

const PREFILTER_PAD_DAYS = 2;
const EVENT_COLUMNS = `id, title, start_date, end_date, start_timezone, end_timezone,
           all_day, location, calendar_name, source`;

/**
 * One stored event row as the MCP reads return it, with its sort key (the
 * start instant; local midnight for all-day events). Null when its start
 * can't be read.
 */
function toListedEvent(row, tz) {
  const isAllDay = row.all_day === 1 || row.all_day === true || DATE_ONLY.test(row.start_date || '');

  if (isAllDay) {
    const start = (row.start_date || '').slice(0, 10);
    if (!DATE_ONLY.test(start)) return null;
    let end = (row.end_date || '').slice(0, 10);
    if (!DATE_ONLY.test(end) || end <= start) end = addDays(start, 1);
    const startInstant = wallTimeToInstant(`${start}T00:00:00`, tz);
    return {
      sortKey: startInstant.getTime(),
      startInstant,
      endInstant: wallTimeToInstant(`${end}T00:00:00`, tz),
      event: {
        id: row.id,
        title: row.title,
        all_day: true,
        start_date: start,
        end_date: end,
        location: row.location,
        calendar_name: row.calendar_name,
        source: row.source,
      },
    };
  }

  const start = eventInstant(row.start_date, row.start_timezone, tz);
  if (!start) return null;
  let end = eventInstant(row.end_date || row.start_date, row.end_timezone || row.start_timezone, tz) || start;
  if (end < start) end = start;

  return {
    sortKey: start.getTime(),
    startInstant: start,
    endInstant: end,
    event: {
      id: row.id,
      title: row.title,
      all_day: false,
      start: isoInZone(start, tz),
      end: isoInZone(end, tz),
      start_utc: start.toISOString().replace('.000Z', 'Z'),
      end_utc: end.toISOString().replace('.000Z', 'Z'),
      event_timezone: row.start_timezone || null,
      location: row.location,
      calendar_name: row.calendar_name,
      source: row.source,
    },
  };
}

/**
 * Events overlapping `days` local days starting at `date` (default: today).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{date?: string, days?: number}} args
 * @param {{timezone?: string, now?: Date}} [opts]
 * @returns {{info: object, from: string, to: string, days: number, events: object[]}}
 *   `to` is the last local day included. All-day events carry start_date and
 *   an exclusive end_date; timed events carry start/end in the user's zone
 *   with offset, start_utc/end_utc, and the event's own zone when known.
 */
export function listEventsForDays(db, args = {}, opts = {}) {
  const info = timeZoneInfo(opts);
  const tz = info.user_timezone;

  const from = args.date || info.today;
  if (!DATE_ONLY.test(from)) {
    throw new Error(`date must be YYYY-MM-DD, got "${from}"`);
  }
  const days = normalizeDays(args.days);
  const endDay = addDays(from, days); // exclusive

  const rangeStart = wallTimeToInstant(`${from}T00:00:00`, tz);
  const rangeEnd = wallTimeToInstant(`${endDay}T00:00:00`, tz);

  // A wide string prefilter: stored values are UTC or a local time in the
  // event's own zone, and offsets run from -12:00 to +14:00, so a stored date
  // can sit up to two days from the user's local date. The exact overlap
  // test runs below on real instants.
  const rows = db.prepare(`
    SELECT ${EVENT_COLUMNS}
    FROM events
    WHERE start_date < ? AND COALESCE(end_date, start_date) >= ?
  `).all(addDays(endDay, PREFILTER_PAD_DAYS), addDays(from, -PREFILTER_PAD_DAYS));

  const events = [];
  for (const row of rows) {
    const item = toListedEvent(row, tz);
    if (!item) continue;
    if (item.event.all_day) {
      if (item.event.start_date < endDay && item.event.end_date > from) events.push(item);
      continue;
    }
    const start = item.startInstant;
    const end = item.endInstant;
    if (start < rangeEnd && (end > rangeStart || start >= rangeStart)) events.push(item);
  }

  events.sort((a, b) =>
    (b.event.all_day - a.event.all_day) || (a.sortKey - b.sortKey) || String(a.event.id).localeCompare(String(b.event.id))
  );

  return { info, from, to: addDays(endDay, -1), days, events: events.map(e => e.event) };
}

/**
 * The next `limit` events with no end date bound: anything still running or
 * yet to start, from the start of today in the user's zone, in start order
 * (all-day events at local midnight), so far-off events still appear when
 * the calendar is quiet.
 */
export function listUpcomingEvents(db, { limit = 50 } = {}, opts = {}) {
  const info = timeZoneInfo(opts);
  const tz = info.user_timezone;
  const cap = Math.max(1, Math.min(500, Math.floor(Number(limit)) || 50));
  const todayStart = wallTimeToInstant(`${info.today}T00:00:00`, tz);

  const rows = db.prepare(`
    SELECT ${EVENT_COLUMNS}
    FROM events
    WHERE COALESCE(end_date, start_date) >= ?
    ORDER BY start_date
  `).all(addDays(info.today, -PREFILTER_PAD_DAYS));

  const events = [];
  for (const row of rows) {
    const item = toListedEvent(row, tz);
    if (!item) continue;
    const running = item.event.all_day
      ? item.event.end_date > info.today
      : (item.endInstant > todayStart || item.startInstant >= todayStart);
    if (running) events.push(item);
  }
  events.sort((a, b) => (a.sortKey - b.sortKey) || String(a.event.id).localeCompare(String(b.event.id)));

  return {
    info,
    total: events.length,
    has_more: events.length > cap,
    events: events.slice(0, cap).map(e => e.event),
  };
}

/** The text reply for list_events: a line on where the user is, then JSON. */
export function formatEventList(result) {
  const { info, from, to, events } = result;
  const span = from === to ? from : `${from} through ${to}`;
  const summary = `${events.length} event${events.length === 1 ? '' : 's'} on ${span} (local days, overlapping events included). ` +
    'Timed events give start/end in the user\'s zone with offset and start_utc/end_utc; all-day events give start_date and an exclusive end_date.';
  return `${timeZoneLine(info)}\n${summary}\n\n${JSON.stringify({ ...info, from, to, events }, null, 2)}`;
}

/** "9:30 AM EST" for a timed event, "All day" otherwise, for prompts. */
export function eventTimeLabel(event, tz) {
  if (event.all_day) return 'All day';
  return format(new TZDate(new Date(event.start_utc).getTime(), tz), 'h:mm a zzz');
}

/**
 * The event to send to an events plugin's create action. A time with Z or an
 * offset is kept as given; one without is a wall time in `timezone` (default:
 * the configured zone), and the zone travels with it so the calendar books
 * it there rather than in the plugin's fallback zone.
 *
 * @returns {{event: object, startInstant: Date|null, timezone: string}}
 */
export function buildCreateEvent(args) {
  if (args.timezone && !isValidTimezone(args.timezone)) {
    throw new Error(`Unknown time zone "${args.timezone}". Use an IANA name such as America/New_York.`);
  }
  const tz = zoneOrDefault(args.timezone);
  const startDate = args.start_date;
  const endDate = args.end_date || args.start_date;

  if (!args.all_day) {
    for (const [name, value] of [['start_date', startDate], ['end_date', endDate]]) {
      if (!eventInstant(value, null, tz)) {
        throw new Error(`${name} must be a date-time such as 2026-11-05T14:00:00 or 2026-11-05T14:00:00-05:00 (got "${value}"); set all_day for a date-only event`);
      }
    }
  }

  return {
    event: {
      title: args.title,
      start_date: startDate,
      end_date: endDate,
      location: args.location,
      description: args.description,
      all_day: args.all_day,
      timezone: tz,
      start_timezone: tz,
      end_timezone: tz,
    },
    startInstant: args.all_day ? null : eventInstant(startDate, null, tz),
    timezone: tz,
  };
}

