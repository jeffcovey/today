import { currentEdge, decide, localDate, localNow } from '../plugins/hosting/status.js';

const tz = 'America/New_York';
const times = { checkinTime: '15:00', checkoutTime: '12:00', timezone: tz };
const at = (today, time) => ({ today, time, ...times });

describe('hosting status edges', () => {
  const stay = { start: '2026-11-09', end: '2026-11-13' };
  const next = { start: '2026-11-13', end: '2026-11-15' };

  test('a booking arrives on its start date only after check-in time', () => {
    expect(currentEdge([stay], at('2026-11-09', '14:59'))).toBeNull();
    expect(currentEdge([stay], at('2026-11-09', '15:00'))).toEqual({ status: 'Occupied', key: 'Occupied:2026-11-09' });
  });

  test('the arrival edge keeps the same key for the whole stay', () => {
    expect(currentEdge([stay], at('2026-11-11', '09:00')).key).toBe('Occupied:2026-11-09');
  });

  test('checkout day is Dirty after checkout time, not Occupied', () => {
    expect(currentEdge([stay], at('2026-11-13', '11:59'))).toBeNull();
    expect(currentEdge([stay], at('2026-11-13', '16:00'))).toEqual({ status: 'Dirty', key: 'Dirty:2026-11-13' });
  });

  test('back-to-back: Dirty after checkout, Occupied after the next check-in', () => {
    expect(currentEdge([stay, next], at('2026-11-13', '13:00')).status).toBe('Dirty');
    expect(currentEdge([stay, next], at('2026-11-13', '15:30'))).toEqual({ status: 'Occupied', key: 'Occupied:2026-11-13' });
  });

  test('datetime bookings are read in the configured time zone', () => {
    expect(localDate('2026-11-13T02:00:00Z', tz)).toBe('2026-11-12');
  });

  test('localNow reports local date and time, not UTC', () => {
    expect(localNow(tz, new Date('2026-11-13T00:30:00Z'))).toEqual({ today: '2026-11-12', time: '19:30' });
  });
});

describe('decide', () => {
  const edge = { status: 'Occupied', key: 'Occupied:2026-11-09' };

  test('a manual status survives while the edge is unchanged', () => {
    expect(decide(edge, 'Occupied:2026-11-09')).toEqual({ write: false, record: false });
  });

  test('a new edge is written', () => {
    expect(decide(edge, 'Dirty:2026-11-08')).toEqual({ write: true, record: true });
  });

  test('the first run records the edge without overwriting', () => {
    expect(decide(edge, undefined)).toEqual({ write: false, record: true });
  });

  test('no edge, no change', () => {
    expect(decide(null, 'Occupied:2026-11-09')).toEqual({ write: false, record: false });
  });
});
