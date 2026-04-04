import {
  parseDuration,
  formatDuration,
  formatDurationMinutes,
  calculateDurationMinutes,
} from '../src/duration-utils.js';

describe('duration-utils', () => {
  describe('parseDuration', () => {
    test('returns 0 for null/undefined/empty input', () => {
      expect(parseDuration(null)).toBe(0);
      expect(parseDuration(undefined)).toBe(0);
      expect(parseDuration('')).toBe(0);
    });

    test('parses decimal hours (e.g. "1.5h")', () => {
      expect(parseDuration('1.5h')).toBe(90);
      expect(parseDuration('0.5h')).toBe(30);
      expect(parseDuration('2h')).toBe(120);
      expect(parseDuration('0.5hours')).toBe(30);
      expect(parseDuration('1.5hour')).toBe(90);
    });

    test('parses hours + minutes (e.g. "2h30m")', () => {
      expect(parseDuration('2h30m')).toBe(150);
      expect(parseDuration('1h15m')).toBe(75);
      expect(parseDuration('1h0m')).toBe(60);
      expect(parseDuration('1hours30minutes')).toBe(90);
    });

    test('parses just hours (e.g. "3h")', () => {
      expect(parseDuration('3h')).toBe(180);
      expect(parseDuration('1h')).toBe(60);
      expect(parseDuration('3hours')).toBe(180);
    });

    test('parses just minutes (e.g. "20m")', () => {
      expect(parseDuration('20m')).toBe(20);
      expect(parseDuration('90m')).toBe(90);
      expect(parseDuration('35minutes')).toBe(35);
      expect(parseDuration('5min')).toBe(5);
    });

    test('ignores whitespace', () => {
      expect(parseDuration('  1h 30m  ')).toBe(90);
      expect(parseDuration(' 45m ')).toBe(45);
    });

    test('is case insensitive', () => {
      expect(parseDuration('1H')).toBe(60);
      expect(parseDuration('30M')).toBe(30);
      expect(parseDuration('1H30M')).toBe(90);
    });

    test('returns 0 for unrecognized input', () => {
      expect(parseDuration('abc')).toBe(0);
      expect(parseDuration('invalid')).toBe(0);
    });

    test('coerces numeric input to string', () => {
      expect(parseDuration(30)).toBe(0); // "30" has no unit, returns 0
    });
  });

  describe('formatDuration', () => {
    test('formats seconds with hours and minutes', () => {
      expect(formatDuration(3600)).toBe('1h 0m');
      expect(formatDuration(5400)).toBe('1h 30m');
      expect(formatDuration(7260)).toBe('2h 1m');
    });

    test('formats seconds under one hour as just minutes', () => {
      expect(formatDuration(1800)).toBe('30m');
      expect(formatDuration(60)).toBe('1m');
      expect(formatDuration(2700)).toBe('45m');
    });

    test('formats zero seconds as 0m', () => {
      expect(formatDuration(0)).toBe('0m');
    });

    test('ignores fractional seconds', () => {
      expect(formatDuration(3661)).toBe('1h 1m');
    });
  });

  describe('formatDurationMinutes', () => {
    test('formats minutes with hours and minutes', () => {
      expect(formatDurationMinutes(90)).toBe('1h 30m');
      expect(formatDurationMinutes(60)).toBe('1h 0m');
      expect(formatDurationMinutes(120)).toBe('2h 0m');
    });

    test('formats minutes under one hour as just minutes', () => {
      expect(formatDurationMinutes(45)).toBe('45m');
      expect(formatDurationMinutes(1)).toBe('1m');
    });

    test('formats zero minutes as 0m', () => {
      expect(formatDurationMinutes(0)).toBe('0m');
    });
  });

  describe('calculateDurationMinutes', () => {
    test('calculates duration in minutes between two ISO timestamps', () => {
      expect(calculateDurationMinutes('2025-12-09T10:00:00Z', '2025-12-09T11:00:00Z')).toBe(60);
      expect(calculateDurationMinutes('2025-12-09T10:00:00Z', '2025-12-09T10:30:00Z')).toBe(30);
      expect(calculateDurationMinutes('2025-12-09T09:00:00Z', '2025-12-09T11:45:00Z')).toBe(165);
    });

    test('calculates duration between Date objects', () => {
      const start = new Date('2025-12-09T10:00:00Z');
      const end = new Date('2025-12-09T11:30:00Z');
      expect(calculateDurationMinutes(start, end)).toBe(90);
    });

    test('returns 0 for equal start and end times', () => {
      expect(calculateDurationMinutes('2025-12-09T10:00:00Z', '2025-12-09T10:00:00Z')).toBe(0);
    });

    test('returns negative value when end is before start', () => {
      expect(calculateDurationMinutes('2025-12-09T11:00:00Z', '2025-12-09T10:00:00Z')).toBe(-60);
    });

    test('returns NaN for invalid date inputs', () => {
      expect(isNaN(calculateDurationMinutes('invalid', 'invalid'))).toBe(true);
    });
  });
});
