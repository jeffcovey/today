/**
 * Time parsing shared by the MCP write tools in this directory.
 *
 * A caller may send an instant with an offset ("2026-11-01T09:00:00-05:00",
 * or Z), or a naive local time ("2026-11-01T09:00", "2026-11-01 09:00"),
 * which is read in the given zone, never the host's. Naive times are built
 * with the TZDate component constructor, since `new TZDate(string, tz)`
 * parses in the host zone.
 */

import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

const WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})$/;

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function inRange(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

/**
 * Parse a caller's time into a Date.
 *
 * @param {string} input
 * @param {string} tz - zone for naive times
 * @param {object} [options]
 * @param {boolean} [options.allowTimeOnly] - accept "HH:MM" as today in `tz`
 * @param {Date} [options.now] - the reference instant whose day in `tz` is "today"
 *   for HH:MM; pass the handler's own clock so it agrees with its other checks
 * @returns {{date: Date, naive: boolean} | {error: string}}
 */
export function parseCallerTime(input, tz, { allowTimeOnly = false, now = new Date() } = {}) {
  const text = String(input ?? '').trim();
  let m = text.match(WITH_OFFSET);
  if (m) {
    const [, y, mo, d, h, mi, s = '0'] = m;
    const date = new Date(text);
    if (!inRange(+y, +mo, +d, +h, +mi, +s) || isNaN(date.getTime())) {
      return { error: `"${text}" is not a valid date and time` };
    }
    return { date, naive: false };
  }

  m = text.match(NAIVE);
  if (!m && allowTimeOnly) {
    const t = text.match(TIME_ONLY);
    if (t) {
      const [y, mo, d] = format(new TZDate(now.getTime(), tz), 'yyyy-MM-dd').split('-');
      m = [text, y, mo, d, t[1].padStart(2, '0'), t[2], '0'];
    }
  }
  if (m) {
    const [, y, mo, d, h, mi, s = '0'] = m;
    if (!inRange(+y, +mo, +d, +h, +mi, +s)) return { error: `"${text}" is not a valid date and time` };
    const zoned = new TZDate(+y, +mo - 1, +d, +h, +mi, +s, 0, tz);
    return { date: new Date(zoned.getTime()), naive: true };
  }

  const forms = allowTimeOnly
    ? 'an ISO time with an offset (2026-11-01T09:00:00-05:00), a local time (2026-11-01T09:00), or HH:MM for today'
    : 'an ISO time with an offset (2026-11-01T09:00:00-05:00) or a local time (2026-11-01T09:00)';
  return { error: `Could not read "${text}" as a time. Use ${forms}.` };
}

/** An instant as ISO 8601 with the zone's offset. */
export function formatInZone(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  return format(new TZDate(d.getTime(), tz), "yyyy-MM-dd'T'HH:mm:ssxxx");
}
