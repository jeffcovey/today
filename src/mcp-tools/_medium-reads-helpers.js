/**
 * Helpers shared by the read tools in this directory. The leading underscore
 * keeps the registry from loading this file as a tool module.
 *
 * Dates: "today" and every local day are worked out in the configured time
 * zone, never the host's. Stored instants with a Z or an offset are converted
 * to that zone; naive "YYYY-MM-DDTHH:MM" strings (markdown sources) are
 * already local wall time and are read as such.
 */

import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { getConfiguredTimezone } from '../date-utils.js';
import { staleNote } from '../mcp-reads.js';

export { getConfiguredTimezone };

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;

/** A number held to min..max; fallback when missing or not a number. */
export function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Today's date (YYYY-MM-DD) in tz, at `now`. */
export function todayIn(tz, now = new Date()) {
  return format(new TZDate(now.getTime(), tz), 'yyyy-MM-dd');
}

/** Whether s is a real calendar date written YYYY-MM-DD. */
export function isDay(s) {
  const m = DAY_RE.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** day + n days, as YYYY-MM-DD (pure calendar arithmetic). */
export function addDays(day, n) {
  const m = DAY_RE.exec(day);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return d.toISOString().slice(0, 10);
}

/**
 * A stored date or date-time as { day, iso } in tz. iso carries the zone's
 * offset, or is null for a date with no time.
 */
export function toLocal(value, tz) {
  if (value === null || value === undefined || value === '') return { day: null, iso: null };
  const s = String(value).trim();
  if (OFFSET_RE.test(s)) {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) return { day: s.slice(0, 10), iso: null };
    const local = new TZDate(ms, tz);
    return { day: format(local, 'yyyy-MM-dd'), iso: format(local, "yyyy-MM-dd'T'HH:mm:ssxxx") };
  }
  const m = NAIVE_RE.exec(s);
  if (!m) return { day: s.slice(0, 10), iso: null };
  if (m[4] === undefined) return { day: `${m[1]}-${m[2]}-${m[3]}`, iso: null };
  const local = new TZDate(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0, tz);
  return { day: `${m[1]}-${m[2]}-${m[3]}`, iso: format(local, "yyyy-MM-dd'T'HH:mm:ssxxx") };
}

/** Cut text to max characters, saying whether it was cut. */
export function cap(text, max) {
  if (text === null || text === undefined) return { text: null, truncated: false, length: 0 };
  const s = String(text);
  if (s.length <= max) return { text: s, truncated: false, length: s.length };
  return { text: `${s.slice(0, max)}…`, truncated: true, length: s.length };
}

export function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Escape LIKE wildcards in user text; use with ESCAPE '\'. */
export function likeTerm(text) {
  return `%${String(text).replace(/[\\%_]/g, c => `\\${c}`)}%`;
}

export function isMissingTable(error) {
  return /no such table/i.test(error?.message || '');
}

/**
 * Freshen a plugin type before a read, within the server's budget, and
 * return a stale-data note or null. Tests may call handlers without a sync.
 */
export async function freshen(ctx, pluginType, label) {
  if (typeof ctx?.syncForRead !== 'function') return null;
  const sync = await ctx.syncForRead(ctx.db, pluginType);
  return staleNote(label, sync);
}

/** A lead line, with the stale note after it when there is one. */
export function lead(text, note) {
  return note ? `${text}\n${note}` : text;
}

/**
 * A stored or summed number for a machine-readable field, at the precision it
 * was stored with (YNAB milliunits keep their third decimal; 0.004 stays
 * 0.004). Only binary floating-point noise from a sum (0.1 + 0.2) is cleared,
 * by keeping 15 significant digits, which every stored decimal fits in.
 */
export function exact(n) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return null;
  return Number(Number(n).toPrecision(15));
}

export const money = exact;

/**
 * An amount for display text only: cents, half away from zero in both
 * directions (-1.125 shows as -1.13, as 1.125 shows as 1.13).
 */
export function moneyText(n) {
  const v = exact(n);
  if (v === null) return null;
  const cents = Math.round(Math.abs(v) * 100 + 1e-9) / 100;
  return `${v < 0 && cents !== 0 ? '-' : ''}${cents.toFixed(2)}`;
}
