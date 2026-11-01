/**
 * Small helpers shared by the tool modules in this directory: dates as
 * YYYY-MM-DD strings, instants in the configured zone, bounded integers and
 * the freshness note before a read.
 */

import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { staleNote } from '../mcp-reads.js';

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a string is a real calendar date written YYYY-MM-DD. */
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/** Calendar-day arithmetic on YYYY-MM-DD, in UTC so no zone shifts it. */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Escape % and _ for a LIKE pattern used with ESCAPE '\'. */
export function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, ch => `\\${ch}`);
}

const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/**
 * An instant from a stored timestamp. A timestamp with an offset or Z is
 * taken as written; one without is wall time in `tz` (never the host zone).
 * @returns {Date|null}
 */
export function parseInstant(value, tz) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (OFFSET_SUFFIX.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = text.match(WALL_TIME);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  const date = new TZDate(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), 0, tz);
  return Number.isNaN(date.getTime()) ? null : new Date(date.getTime());
}

/** An instant written with its offset in `tz`, or the raw value if unreadable. */
export function formatInstant(value, tz) {
  const d = parseInstant(value, tz);
  if (!d) return value ?? null;
  return format(new TZDate(d.getTime(), tz), "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/** The local calendar date in `tz` of a stored timestamp. */
export function localDateOf(value, tz) {
  const d = parseInstant(value, tz);
  if (!d) return null;
  return format(new TZDate(d.getTime(), tz), 'yyyy-MM-dd');
}

/**
 * Freshen a plugin type before a read, within the server's budget.
 * @returns {Promise<string|null>} A note when the data may be behind.
 */
export async function freshen(ctx, pluginType, label) {
  if (typeof ctx?.syncForRead !== 'function') return null;
  const sync = await ctx.syncForRead(ctx.db, pluginType);
  return sync ? staleNote(label, sync) : null;
}

/** Put a freshness note ahead of a result's content. */
export function withNote(result, note) {
  if (!note) return result;
  return { ...result, content: [{ type: 'text', text: note }, ...result.content] };
}

/** `#topic/...` tags in a description, as bin/track reads them. */
export function topicTags(text) {
  return String(text || '').match(/#topic\/[\w-]+/g) || [];
}
