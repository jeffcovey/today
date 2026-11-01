/**
 * MCP calendar reads pick events by overlap with the user's local days and
 * report every time in the configured zone with its offset, plus UTC;
 * create_event reads times without an offset in that zone.
 */

import Database from 'better-sqlite3';
import {
  addDays,
  eventInstant,
  timeZoneInfo,
  timeZoneLine,
  listEventsForDays,
  formatEventList,
  eventTimeLabel,
  buildCreateEvent,
  LIST_EVENTS_MAX_DAYS,
} from '../src/mcp-events.js';
import { getLocalDayUTCRange, wallTimeInZone } from '../src/date-utils.js';

const NY = 'America/New_York';
const LONDON = 'Europe/London';
const TOKYO = 'Asia/Tokyo';
// 9:02 AM Eastern on Sunday 1 Nov 2026 (EST, UTC-05:00).
const NOW = new Date('2026-11-01T14:02:17Z');

function eventDb(rows) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (
    id TEXT PRIMARY KEY, source TEXT, calendar_name TEXT, title TEXT,
    start_date TEXT, end_date TEXT, start_timezone TEXT, end_timezone TEXT,
    location TEXT, description TEXT, all_day INTEGER
  )`);
  const insert = db.prepare(`INSERT INTO events
    (id, source, calendar_name, title, start_date, end_date, start_timezone, end_timezone, location, all_day)
    VALUES (@id, 'google-calendar/personal', 'Personal', @title, @start, @end, @tz, @tz, NULL, @all_day)`);
  for (const r of rows) insert.run({ tz: null, all_day: 0, end: r.start, ...r });
  return db;
}

const titles = result => result.events.map(e => e.title);

describe('timeZoneInfo', () => {
  test('names the zone, its offset, the local time and the local date', () => {
    expect(timeZoneInfo({ timezone: NY, now: NOW })).toEqual({
      user_timezone: NY,
      utc_offset: '-05:00',
      now: '2026-11-01T09:02:17-05:00',
      today: '2026-11-01',
    });
    expect(timeZoneLine(timeZoneInfo({ timezone: NY, now: NOW }))).toBe(
      "Times are in America/New_York (UTC-05:00), the user's configured time zone. Now: 2026-11-01T09:02:17-05:00. Today: 2026-11-01."
    );
  });

  test('follows a trip zone, where it may already be tomorrow', () => {
    const late = new Date('2026-11-01T23:30:00Z');
    expect(timeZoneInfo({ timezone: TOKYO, now: late })).toMatchObject({
      utc_offset: '+09:00', now: '2026-11-02T08:30:00+09:00', today: '2026-11-02',
    });
  });
});

describe('eventInstant', () => {
  test('a time with Z or an offset is used as given', () => {
    expect(eventInstant('2026-11-01T23:30:00Z', null, NY).toISOString()).toBe('2026-11-01T23:30:00.000Z');
    expect(eventInstant('2026-11-01T18:30:00-05:00', null, LONDON).toISOString()).toBe('2026-11-01T23:30:00.000Z');
  });

  test("a time without one is read in the event's zone, else the user's", () => {
    expect(eventInstant('2026-11-01T18:30:00', LONDON, NY).toISOString()).toBe('2026-11-01T18:30:00.000Z');
    expect(eventInstant('2026-11-01T18:30:00', null, NY).toISOString()).toBe('2026-11-01T23:30:00.000Z');
  });

  test('a date alone has no instant', () => {
    expect(eventInstant('2026-11-01', null, NY)).toBeNull();
  });
});

describe('listEventsForDays', () => {
  const rows = [
    // 6:30 PM Eastern: UTC already says Nov 2.
    { id: 'evening', title: 'Evening mixer', start: '2026-11-01T23:30:00Z', end: '2026-11-02T01:00:00Z' },
    { id: 'morning', title: 'Morning sit', start: '2026-11-01T11:00:00Z', end: '2026-11-01T12:00:00Z' },
    // Began yesterday, still running today.
    { id: 'retreat', title: 'Retreat', start: '2026-10-31T14:00:00Z', end: '2026-11-01T20:00:00Z' },
    { id: 'trip', title: 'Trip', start: '2026-10-30', end: '2026-11-03', all_day: 1 },
    { id: 'tomorrow-allday', title: 'Tomorrow', start: '2026-11-02', end: '2026-11-03', all_day: 1 },
    // 8 PM Eastern on Oct 31 is Nov 1 in UTC: not today.
    { id: 'last-night', title: 'Last night', start: '2026-11-01T00:00:00Z', end: '2026-11-01T02:00:00Z' },
    // A feed's local time with its own zone: 2 PM London = 9 AM Eastern.
    { id: 'floating', title: 'London call', start: '2026-11-01T14:00:00', end: '2026-11-01T15:00:00', tz: LONDON },
    { id: 'zero', title: 'Reminder', start: '2026-11-01T15:00:00Z', end: '2026-11-01T15:00:00Z' },
  ];

  test("today in New York: the evening event, overlapping events, and nothing from last night", () => {
    const result = listEventsForDays(eventDb(rows), {}, { timezone: NY, now: NOW });
    expect(result).toMatchObject({ from: '2026-11-01', to: '2026-11-01', days: 1 });
    expect(titles(result)).toEqual(['Trip', 'Retreat', 'Morning sit', 'London call', 'Reminder', 'Evening mixer']);
  });

  test('timed events carry local and UTC times and the event zone', () => {
    const result = listEventsForDays(eventDb(rows), {}, { timezone: NY, now: NOW });
    expect(result.events.find(e => e.id === 'evening')).toMatchObject({
      all_day: false,
      start: '2026-11-01T18:30:00-05:00',
      end: '2026-11-01T20:00:00-05:00',
      start_utc: '2026-11-01T23:30:00Z',
      end_utc: '2026-11-02T01:00:00Z',
      event_timezone: null,
    });
    expect(result.events.find(e => e.id === 'floating')).toMatchObject({
      start: '2026-11-01T09:00:00-05:00', start_utc: '2026-11-01T14:00:00Z', event_timezone: LONDON,
    });
    expect(result.events.find(e => e.id === 'trip')).toEqual(expect.objectContaining({
      all_day: true, start_date: '2026-10-30', end_date: '2026-11-03',
    }));
  });

  test('the same data seen from Tokyo on a trip', () => {
    const late = new Date('2026-11-01T23:30:00Z'); // 8:30 AM Nov 2 in Tokyo
    const result = listEventsForDays(eventDb(rows), {}, { timezone: TOKYO, now: late });
    expect(result.from).toBe('2026-11-02');
    expect(titles(result)).toEqual(['Trip', 'Tomorrow', 'Retreat', 'Reminder', 'Evening mixer']);
    expect(result.events.find(e => e.id === 'evening').start).toBe('2026-11-02T08:30:00+09:00');
  });

  test('a date and a span of days', () => {
    const result = listEventsForDays(eventDb(rows), { date: '2026-10-31', days: 2 }, { timezone: NY, now: NOW });
    expect(result).toMatchObject({ from: '2026-10-31', to: '2026-11-01', days: 2 });
    expect(titles(result)).toContain('Last night');
    expect(titles(result)).toContain('Evening mixer');
    expect(titles(result)).not.toContain('Tomorrow');
  });

  test('days are clamped and a bad date is refused', () => {
    const db = eventDb([]);
    expect(listEventsForDays(db, { days: 0 }, { timezone: NY, now: NOW }).days).toBe(1);
    expect(listEventsForDays(db, { days: 500 }, { timezone: NY, now: NOW }).days).toBe(LIST_EVENTS_MAX_DAYS);
    expect(() => listEventsForDays(db, { date: 'tomorrow' }, { timezone: NY, now: NOW })).toThrow('YYYY-MM-DD');
  });

  test('the reply opens with where the user is', () => {
    const text = formatEventList(listEventsForDays(eventDb(rows), {}, { timezone: NY, now: NOW }));
    const [first, second] = text.split('\n');
    expect(first).toContain('America/New_York (UTC-05:00)');
    expect(second).toMatch(/^6 events on 2026-11-01 /);
    const json = JSON.parse(text.slice(text.indexOf('{')));
    expect(json).toMatchObject({ user_timezone: NY, today: '2026-11-01', from: '2026-11-01', to: '2026-11-01' });
    expect(json.events).toHaveLength(6);
  });

  test('prompt labels use local clock time, not the UTC digits', () => {
    const result = listEventsForDays(eventDb(rows), {}, { timezone: NY, now: NOW });
    expect(eventTimeLabel(result.events.find(e => e.id === 'evening'), NY)).toMatch(/^6:30 PM /);
    expect(eventTimeLabel(result.events.find(e => e.id === 'trip'), NY)).toBe('All day');
  });
});

describe('buildCreateEvent', () => {
  test('a time without an offset goes out with the configured zone', () => {
    const { event, startInstant, timezone } = buildCreateEvent({
      title: 'Lunch', start_date: '2026-11-05T14:00:00', timezone: LONDON,
    });
    expect(timezone).toBe(LONDON);
    expect(event).toMatchObject({ start_date: '2026-11-05T14:00:00', end_date: '2026-11-05T14:00:00', timezone: LONDON, start_timezone: LONDON });
    expect(startInstant.toISOString()).toBe('2026-11-05T14:00:00.000Z');
  });

  test('a time with an offset keeps its instant', () => {
    const { startInstant } = buildCreateEvent({ title: 'Call', start_date: '2026-11-05T14:00:00-05:00', timezone: LONDON });
    expect(startInstant.toISOString()).toBe('2026-11-05T19:00:00.000Z');
  });

  test('all-day events need no time', () => {
    const { startInstant, event } = buildCreateEvent({ title: 'Holiday', start_date: '2026-11-26', all_day: true, timezone: NY });
    expect(startInstant).toBeNull();
    expect(event.all_day).toBe(true);
  });

  test('a bad zone or a date-only timed event is refused', () => {
    expect(() => buildCreateEvent({ title: 'x', start_date: '2026-11-05T14:00:00', timezone: 'Mars/Olympus' })).toThrow('Unknown time zone');
    expect(() => buildCreateEvent({ title: 'x', start_date: '2026-11-05', timezone: NY })).toThrow('all_day');
  });
});

describe('date-utils wall times', () => {
  test('getLocalDayUTCRange gives the local day in UTC, whatever the host zone', () => {
    expect(getLocalDayUTCRange('2026-11-01', NY)).toEqual({
      start: '2026-11-01T04:00:00.000Z', // midnight EDT; clocks fall back at 2 AM
      end: '2026-11-02T04:59:59.999Z',
    });
    expect(getLocalDayUTCRange('2026-11-02', TOKYO).start).toBe('2026-11-01T15:00:00.000Z');
  });

  test('wallTimeInZone reads the time in the given zone, not the host one', () => {
    expect(wallTimeInZone('2026-11-01T18:30:00', NY).toISOString()).toBe('2026-11-01T23:30:00.000Z');
    expect(wallTimeInZone('2026-07-01T09:00', LONDON).toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(Number.isNaN(wallTimeInZone('soon', NY).getTime())).toBe(true);
  });
});

test('addDays crosses months and DST without drifting', () => {
  expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
});
