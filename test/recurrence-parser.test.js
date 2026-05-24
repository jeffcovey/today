import {
  parseRecurrence,
  getCurrentPeriodStart,
  getNextPeriodStart,
  isNewPeriod,
  formatDate,
} from '../src/recurrence-parser.js';

describe('recurrence-parser', () => {
  describe('parseRecurrence', () => {
    test('parses "daily"', () => {
      expect(parseRecurrence('daily')).toEqual({ type: 'daily' });
    });

    test('parses weekday patterns', () => {
      expect(parseRecurrence('on weekdays')).toEqual({ type: 'weekly', days: [1, 2, 3, 4, 5] });
      expect(parseRecurrence('on weekday')).toEqual({ type: 'weekly', days: [1, 2, 3, 4, 5] });
      expect(parseRecurrence('weekdays')).toEqual({ type: 'weekly', days: [1, 2, 3, 4, 5] });
    });

    test('parses weekend patterns', () => {
      expect(parseRecurrence('on weekends')).toEqual({ type: 'weekly', days: [0, 6] });
      expect(parseRecurrence('on weekend')).toEqual({ type: 'weekly', days: [0, 6] });
      expect(parseRecurrence('weekends')).toEqual({ type: 'weekly', days: [0, 6] });
    });

    test('parses "weekly" defaulting to Monday', () => {
      expect(parseRecurrence('weekly')).toEqual({ type: 'weekly', days: [1] });
    });

    test('parses "weekly on <day>"', () => {
      expect(parseRecurrence('weekly on sunday')).toEqual({ type: 'weekly', days: [0] });
      expect(parseRecurrence('weekly on tuesday')).toEqual({ type: 'weekly', days: [2] });
      expect(parseRecurrence('weekly on saturday')).toEqual({ type: 'weekly', days: [6] });
    });

    test('parses "weekly on Tuesday and Thursday"', () => {
      expect(parseRecurrence('weekly on tuesday and thursday')).toEqual({ type: 'weekly', days: [2, 4] });
    });

    test('parses "monthly" defaulting to 1st', () => {
      expect(parseRecurrence('monthly')).toEqual({ type: 'monthly', day: 1 });
    });

    test('parses "monthly on the Nth"', () => {
      expect(parseRecurrence('monthly on the 15th')).toEqual({ type: 'monthly', day: 15 });
      expect(parseRecurrence('monthly on the 1st')).toEqual({ type: 'monthly', day: 1 });
      expect(parseRecurrence('monthly on the 3rd')).toEqual({ type: 'monthly', day: 3 });
    });

    test('parses "monthly on the last day"', () => {
      expect(parseRecurrence('monthly on the last day')).toEqual({ type: 'monthly', lastDay: true });
    });

    test('parses "monthly on the <ordinal> <day>"', () => {
      expect(parseRecurrence('monthly on the third thursday')).toEqual({ type: 'monthly', ordinal: 2, dayOfWeek: 4 });
      expect(parseRecurrence('monthly on the first monday')).toEqual({ type: 'monthly', ordinal: 0, dayOfWeek: 1 });
      expect(parseRecurrence('monthly on the last friday')).toEqual({ type: 'monthly', ordinal: 5, dayOfWeek: 5 });
    });

    test('parses "monthly on the first day"', () => {
      expect(parseRecurrence('monthly on the first day')).toEqual({ type: 'monthly', day: 1 });
      expect(parseRecurrence('monthly on the second day')).toEqual({ type: 'monthly', day: 2 });
    });

    test('parses "quarterly"', () => {
      expect(parseRecurrence('quarterly')).toEqual({ type: 'quarterly' });
      expect(parseRecurrence('quarterly on the first day')).toEqual({ type: 'quarterly' });
    });

    test('parses "yearly" and "annual" defaulting to Jan 1', () => {
      expect(parseRecurrence('yearly')).toEqual({ type: 'yearly', month: 0, day: 1 });
      expect(parseRecurrence('annual')).toEqual({ type: 'yearly', month: 0, day: 1 });
    });

    test('parses "yearly on <month> <day>"', () => {
      expect(parseRecurrence('yearly on march 15')).toEqual({ type: 'yearly', month: 2, day: 15 });
      expect(parseRecurrence('yearly on december 31')).toEqual({ type: 'yearly', month: 11, day: 31 });
    });

    test('defaults to daily for unrecognized patterns', () => {
      expect(parseRecurrence('unknown pattern')).toEqual({ type: 'daily' });
    });

    test('handles uppercase input via trimming/lowercasing', () => {
      expect(parseRecurrence('  DAILY  ')).toEqual({ type: 'daily' });
    });
  });

  describe('getCurrentPeriodStart', () => {
    test('daily returns today', () => {
      const today = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'daily' }, today);
      expect(formatDate(result)).toBe('2025-12-10');
    });

    test('weekly returns the most recent matching day on or before today', () => {
      // Wednesday Dec 10, 2025 — most recent Monday should be Dec 8
      const wednesday = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'weekly', days: [1] }, wednesday);
      expect(formatDate(result)).toBe('2025-12-08');
    });

    test('weekly returns today when today is a matching day', () => {
      // Monday Dec 8, 2025
      const monday = new Date('2025-12-08T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'weekly', days: [1] }, monday);
      expect(formatDate(result)).toBe('2025-12-08');
    });

    test('weekly falls back to previous week when no match yet this week', () => {
      // Monday Dec 8 — if looking for Wednesday, previous Wed is Dec 3
      const monday = new Date('2025-12-08T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'weekly', days: [3] }, monday);
      expect(formatDate(result)).toBe('2025-12-03');
    });

    test('monthly returns current month day when already passed', () => {
      // Dec 10 — day 5 has already passed, so current period is Dec 5
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'monthly', day: 5 }, date);
      expect(formatDate(result)).toBe('2025-12-05');
    });

    test('monthly returns previous month day when not yet reached', () => {
      // Dec 3 — day 15 is still in the future, so current period is Nov 15
      const date = new Date('2025-12-03T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'monthly', day: 15 }, date);
      expect(formatDate(result)).toBe('2025-11-15');
    });

    test('monthly lastDay returns last day of current month', () => {
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'monthly', lastDay: true }, date);
      expect(formatDate(result)).toBe('2025-12-31');
    });

    test('monthly ordinal weekday returns correct date', () => {
      // First Monday of December 2025: Dec 1 is a Monday
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'monthly', ordinal: 0, dayOfWeek: 1 }, date);
      expect(formatDate(result)).toBe('2025-12-01');
    });

    test('monthly ordinal weekday falls back to previous month when not yet reached', () => {
      // Third Thursday of December 2025: Dec 18
      // Before Dec 18, should return third Thursday of November: Nov 20
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'monthly', ordinal: 2, dayOfWeek: 4 }, date);
      expect(formatDate(result)).toBe('2025-11-20');
    });

    test('quarterly returns start of current quarter', () => {
      // December is Q4 — starts Oct 1
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'quarterly' }, date);
      expect(formatDate(result)).toBe('2025-10-01');

      // April is Q2 — starts Apr 1
      const aprilDate = new Date('2025-04-15T12:00:00Z');
      const aprilResult = getCurrentPeriodStart({ type: 'quarterly' }, aprilDate);
      expect(formatDate(aprilResult)).toBe('2025-04-01');
    });

    test('yearly returns this year target when already passed', () => {
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'yearly', month: 0, day: 1 }, date);
      expect(formatDate(result)).toBe('2025-01-01');
    });

    test('yearly returns last year target when not yet reached', () => {
      const date = new Date('2025-03-01T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'yearly', month: 5, day: 15 }, date);
      expect(formatDate(result)).toBe('2024-06-15');
    });

    test('returns date as-is for unknown type (default case)', () => {
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'unknown' }, date);
      expect(formatDate(result)).toBe('2025-12-10');
    });
  });

  describe('getNextPeriodStart', () => {
    test('daily returns tomorrow', () => {
      const today = new Date('2025-12-10T12:00:00Z');
      const result = getNextPeriodStart({ type: 'daily' }, today);
      expect(formatDate(result)).toBe('2025-12-11');
    });

    test('weekly returns next matching weekday within same week', () => {
      // Monday Dec 8 (day 1) — next Friday (day 5) is within the same week: Dec 12
      const monday = new Date('2025-12-08T12:00:00Z');
      const result = getNextPeriodStart({ type: 'weekly', days: [5] }, monday);
      expect(formatDate(result)).toBe('2025-12-12');
    });

    test('weekly returns next matching weekday', () => {
      // Wednesday Dec 10 — next Monday wraps to next week: Dec 15
      const wednesday = new Date('2025-12-10T12:00:00Z');
      const result = getNextPeriodStart({ type: 'weekly', days: [1] }, wednesday);
      expect(formatDate(result)).toBe('2025-12-15');
    });

    test('weekly wraps to next week when today is after all target days (Sunday targeting Sunday)', () => {
      // Sunday Dec 14 (day 0) with days=[0] — always wraps since 0 is not > 0
      const sunday = new Date('2025-12-14T12:00:00Z');
      const result = getNextPeriodStart({ type: 'weekly', days: [0] }, sunday);
      // Next Sunday: Dec 14 + (7 - 0 + 0) = Dec 21
      expect(formatDate(result)).toBe('2025-12-21');
    });

    test('weekly with multiple days wraps to next week when past all days', () => {
      // Friday Dec 12 (day 5) — next Monday (1) or Tuesday (2) wraps to Dec 15
      const friday = new Date('2025-12-12T12:00:00Z');
      const result = getNextPeriodStart({ type: 'weekly', days: [1, 2] }, friday);
      expect(formatDate(result)).toBe('2025-12-15');
    });

    test('monthly returns same day next month', () => {
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getNextPeriodStart({ type: 'monthly', day: 5 }, date);
      expect(formatDate(result)).toBe('2026-01-05');
    });

    test('monthly lastDay returns last day of next month', () => {
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getNextPeriodStart({ type: 'monthly', lastDay: true }, date);
      expect(formatDate(result)).toBe('2026-01-31');
    });

    test('monthly ordinal weekday returns correct date next month', () => {
      // First Monday of December 2025 is Dec 1; next should be first Monday of Jan 2026 = Jan 5
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getNextPeriodStart({ type: 'monthly', ordinal: 0, dayOfWeek: 1 }, date);
      expect(formatDate(result)).toBe('2026-01-05');
    });

    test('monthly last weekday ordinal falls back when last occurrence is in the future', () => {
      // Last Monday of December 2025 = Dec 29, but we're only at Dec 10
      // Should return last Monday of November 2025 = Nov 24
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'monthly', ordinal: 5, dayOfWeek: 1 }, date);
      expect(formatDate(result)).toBe('2025-11-24');
    });

    test('monthly fifth weekday ordinal falls back when it does not exist in the month', () => {
      // Fifth Monday of November 2025 would be Nov 31 — doesn't exist
      // Falls back to last Monday of November = Nov 24
      // But Nov 24 > Nov 1 (reference), so falls back further to last Monday of October = Oct 27
      const date = new Date('2025-11-01T12:00:00Z');
      const result = getCurrentPeriodStart({ type: 'monthly', ordinal: 4, dayOfWeek: 1 }, date);
      expect(formatDate(result)).toBe('2025-10-27');
    });

    test('monthly wraps year at December', () => {
      const date = new Date('2025-12-31T12:00:00Z');
      const result = getNextPeriodStart({ type: 'monthly', day: 15 }, date);
      expect(formatDate(result)).toBe('2026-01-15');
    });

    test('quarterly returns next quarter start', () => {
      // Q4 starts Oct 1 — next is Jan 1
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getNextPeriodStart({ type: 'quarterly' }, date);
      expect(formatDate(result)).toBe('2026-01-01');

      // Q1 starts Jan 1 — next is Apr 1
      const q1Date = new Date('2025-01-15T12:00:00Z');
      const q1Result = getNextPeriodStart({ type: 'quarterly' }, q1Date);
      expect(formatDate(q1Result)).toBe('2025-04-01');
    });

    test('yearly returns same month/day next year', () => {
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getNextPeriodStart({ type: 'yearly', month: 0, day: 1 }, date);
      expect(formatDate(result)).toBe('2026-01-01');
    });

    test('returns tomorrow for unknown type (default case)', () => {
      const date = new Date('2025-12-10T12:00:00Z');
      const result = getNextPeriodStart({ type: 'unknown' }, date);
      expect(formatDate(result)).toBe('2025-12-11');
    });
  });

  describe('isNewPeriod', () => {
    test('returns false when scheduled date is today', () => {
      const today = new Date('2025-12-10T12:00:00Z');
      expect(isNewPeriod('daily', '2025-12-10', today)).toBe(false);
    });

    test('returns false when scheduled date is in the future', () => {
      const today = new Date('2025-12-10T12:00:00Z');
      expect(isNewPeriod('daily', '2025-12-11', today)).toBe(false);
    });

    test('returns true for daily when scheduled date is yesterday', () => {
      const today = new Date('2025-12-10T12:00:00Z');
      expect(isNewPeriod('daily', '2025-12-09', today)).toBe(true);
    });

    test('returns false for weekly when still in same week', () => {
      // Monday Dec 8 was scheduled, today is Wed Dec 10 — same week
      const today = new Date('2025-12-10T12:00:00Z'); // Wednesday
      expect(isNewPeriod('weekly on monday', '2025-12-08', today)).toBe(false);
    });

    test('returns true for weekly when scheduled is from a previous week', () => {
      // Dec 1 (Monday) was scheduled, today is Dec 10 (Wed) — scheduled is before week start (Dec 8)
      const today = new Date('2025-12-10T12:00:00Z');
      expect(isNewPeriod('weekly on monday', '2025-12-01', today)).toBe(true);
    });

    test('returns false for monthly when same month period', () => {
      // Dec 5 scheduled, today Dec 10 — current monthly period started Dec 5
      const today = new Date('2025-12-10T12:00:00Z');
      expect(isNewPeriod('monthly on the 5th', '2025-12-05', today)).toBe(false);
    });

    test('returns true for monthly when scheduled is from a previous period', () => {
      // Nov 5 scheduled, today Dec 10 — current monthly period started Dec 5
      const today = new Date('2025-12-10T12:00:00Z');
      expect(isNewPeriod('monthly on the 5th', '2025-11-05', today)).toBe(true);
    });
  });

  describe('formatDate', () => {
    test('formats a Date as YYYY-MM-DD', () => {
      expect(formatDate(new Date('2025-12-09T00:00:00'))).toBe('2025-12-09');
      expect(formatDate(new Date('2025-01-05T00:00:00'))).toBe('2025-01-05');
    });

    test('pads single-digit month and day', () => {
      expect(formatDate(new Date(2025, 0, 5))).toBe('2025-01-05');
      expect(formatDate(new Date(2025, 8, 3))).toBe('2025-09-03');
    });
  });
});
