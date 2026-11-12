// Room status follows booking edges (a start, an end) rather than being
// recomputed every sync, so a status set by hand survives until the next edge.

import { wallTimeInZone } from '../../src/date-utils.js';
import { isValidTimezone } from '../../src/timezone-resolver.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function localDate(value, timezone, eventTimezone = timezone) {
  if (DATE_ONLY.test(value)) return value;
  const date = HAS_ZONE.test(value)
    ? new Date(value)
    : wallTimeInZone(value.slice(0, 19), isValidTimezone(eventTimezone) ? eventTimezone : timezone);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function occupancyDateBounds(today) {
  const addDays = days => {
    const [year, month, day] = today.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  };
  return { earliestEnd: addDays(-1), latestStart: addDays(31) };
}

export function localNow(timezone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  return { today: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * The most recent booking edge that has happened by now, or null.
 * @returns {{status: 'Occupied'|'Dirty', key: string}|null}
 */
export function currentEdge(events, { today, time, checkinTime, checkoutTime, timezone }) {
  const bookings = events.map(e => ({
    start: localDate(e.start, timezone, e.start_timezone),
    end: localDate(e.end, timezone, e.end_timezone),
  }));

  const arrived = bookings
    .filter(b => b.start <= today && b.end > today && (b.start < today || time >= checkinTime))
    .sort((a, b) => b.start.localeCompare(a.start))[0];
  if (arrived) return { status: 'Occupied', key: `Occupied:${arrived.start}` };

  const departed = bookings.find(b => b.end === today && time >= checkoutTime);
  if (departed) return { status: 'Dirty', key: `Dirty:${departed.end}` };

  return null;
}

/**
 * Whether to write the edge's status. With no edge on record (first run),
 * the edge is recorded without a write, so an existing status is not clobbered.
 * @returns {{write: boolean, record: boolean}}
 */
export function decide(edge, lastKey) {
  if (!edge) return { write: false, record: lastKey === undefined };
  if (edge.key === lastKey) return { write: false, record: false };
  if (lastKey === undefined) return { write: false, record: true };
  return { write: true, record: true };
}
