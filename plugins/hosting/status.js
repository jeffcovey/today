// Room status follows booking edges (a start, an end) rather than being
// recomputed every sync, so a status set by hand survives until the next edge.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function localDate(value, timezone) {
  if (DATE_ONLY.test(value)) return value;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
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
  const bookings = events.map(e => ({ start: localDate(e.start, timezone), end: localDate(e.end, timezone) }));

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
  if (!edge || edge.key === lastKey) return { write: false, record: false };
  if (lastKey === undefined || lastKey === null) return { write: false, record: true };
  return { write: true, record: true };
}
