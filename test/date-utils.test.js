import { jest } from '@jest/globals';
import {
  formatDate,
  formatDateTime,
  formatTime,
  getStartOfDay,
  getEndOfDay,
  getWeekNumber,
  getQuarterNumber,
  getQuarterString,
  getDateComponents,
  getWeekStart,
  getWeekEnd,
  addDaysToDate,
  getMonth,
  getDay,
  getYear,
  formatDisplayDate,
  formatShortDate,
  getDayName,
  getShortDayName,
} from '../src/date-utils.js';

describe('date-utils', () => {
  // Use a fixed date for consistent testing: Tuesday, December 9, 2025
  const testDate = new Date('2025-12-09T12:00:00');
  const testDateStr = '2025-12-09';

  describe('formatDate', () => {
    test('should format Date object as YYYY-MM-DD', () => {
      expect(formatDate(testDate)).toBe('2025-12-09');
    });

    test('should format ISO string as YYYY-MM-DD', () => {
      expect(formatDate(testDateStr)).toBe('2025-12-09');
    });

    test('should handle single-digit months and days', () => {
      expect(formatDate(new Date('2025-01-05'))).toBe('2025-01-05');
    });
  });

  describe('formatDateTime', () => {
    test('should format Date object as YYYY-MM-DD HH:mm:ss', () => {
      const result = formatDateTime(testDate);
      expect(result).toBe('2025-12-09 12:00:00');
    });
  });

  describe('getWeekNumber', () => {
    test('should return ISO week number', () => {
      // December 9, 2025 is in week 50
      expect(getWeekNumber(testDate)).toBe(50);
    });

    test('should handle string input', () => {
      expect(getWeekNumber(testDateStr)).toBe(50);
    });

    test('should handle week 1 of year', () => {
      // January 6, 2025 is in week 2
      expect(getWeekNumber(new Date('2025-01-06'))).toBe(2);
    });
  });

  describe('getQuarterNumber', () => {
    test('should return quarter 1 for Jan-Mar', () => {
      expect(getQuarterNumber(new Date('2025-01-15'))).toBe(1);
      expect(getQuarterNumber(new Date('2025-03-31'))).toBe(1);
    });

    test('should return quarter 2 for Apr-Jun', () => {
      expect(getQuarterNumber(new Date('2025-04-01'))).toBe(2);
      expect(getQuarterNumber(new Date('2025-06-30'))).toBe(2);
    });

    test('should return quarter 3 for Jul-Sep', () => {
      expect(getQuarterNumber(new Date('2025-07-01'))).toBe(3);
      expect(getQuarterNumber(new Date('2025-09-30'))).toBe(3);
    });

    test('should return quarter 4 for Oct-Dec', () => {
      expect(getQuarterNumber(new Date('2025-10-01'))).toBe(4);
      expect(getQuarterNumber(testDate)).toBe(4);
    });
  });

  describe('getQuarterString', () => {
    test('should return Q1-Q4 format', () => {
      expect(getQuarterString(new Date('2025-02-15'))).toBe('Q1');
      expect(getQuarterString(new Date('2025-05-15'))).toBe('Q2');
      expect(getQuarterString(new Date('2025-08-15'))).toBe('Q3');
      expect(getQuarterString(testDate)).toBe('Q4');
    });
  });

  describe('getDateComponents', () => {
    test('should return all date components', () => {
      const components = getDateComponents(testDate);
      expect(components.year).toBe('2025');
      expect(components.quarter).toBe('Q4');
      expect(components.month).toBe('12');
      expect(components.week).toBe('50');
      expect(components.day).toBe('09');
    });

    test('should pad week number', () => {
      // January 6, 2025 is week 2
      const components = getDateComponents(new Date('2025-01-06'));
      expect(components.week).toBe('02');
    });
  });

  describe('getWeekStart and getWeekEnd', () => {
    test('should return Monday as week start', () => {
      // December 9, 2025 is Tuesday, week starts Monday Dec 8
      const start = getWeekStart(testDate);
      expect(formatDate(start)).toBe('2025-12-08');
    });

    test('should return Sunday as week end', () => {
      // December 9, 2025 is Tuesday, week ends Sunday Dec 14
      const end = getWeekEnd(testDate);
      expect(formatDate(end)).toBe('2025-12-14');
    });
  });

  describe('addDaysToDate', () => {
    test('should add days to date', () => {
      const result = addDaysToDate(testDate, 5);
      expect(formatDate(result)).toBe('2025-12-14');
    });

    test('should subtract days when negative', () => {
      const result = addDaysToDate(testDate, -3);
      expect(formatDate(result)).toBe('2025-12-06');
    });

    test('should handle string input', () => {
      const result = addDaysToDate(testDateStr, 1);
      expect(formatDate(result)).toBe('2025-12-10');
    });
  });

  describe('getMonth, getDay, getYear', () => {
    test('should return two-digit month', () => {
      expect(getMonth(testDate)).toBe('12');
      expect(getMonth(new Date('2025-01-15'))).toBe('01');
    });

    test('should return two-digit day', () => {
      expect(getDay(testDate)).toBe('09');
      expect(getDay(new Date('2025-12-25'))).toBe('25');
    });

    test('should return four-digit year', () => {
      expect(getYear(testDate)).toBe('2025');
    });
  });

  describe('formatDisplayDate', () => {
    test('should format date for display', () => {
      expect(formatDisplayDate(testDate)).toBe('December 9, 2025');
    });
  });

  describe('formatShortDate', () => {
    test('should format date as short string', () => {
      expect(formatShortDate(testDate)).toBe('Dec 9');
    });
  });

  describe('getDayName and getShortDayName', () => {
    test('should return full day name', () => {
      expect(getDayName(testDate)).toBe('Tuesday');
    });

    test('should return short day name', () => {
      expect(getShortDayName(testDate)).toBe('Tue');
    });
  });

  describe('formatTime (timezone-aware)', () => {
    test('should include timezone abbreviation in output', () => {
      // Use a fixed UTC time and check it includes timezone info
      const utcTime = '2025-12-09T17:30:00Z'; // 5:30 PM UTC
      const result = formatTime(utcTime, 'America/New_York');
      // Should be 12:30 PM Eastern (UTC-5 in winter)
      expect(result).toMatch(/12:30 PM/);
      expect(result).toMatch(/GMT-5|EST/); // Should include timezone indicator
    });

    test('should format morning time correctly', () => {
      const utcTime = '2025-12-09T13:00:00Z'; // 1 PM UTC = 8 AM Eastern
      const result = formatTime(utcTime, 'America/New_York');
      expect(result).toMatch(/8:00 AM/);
    });

    test('should format evening time correctly', () => {
      const utcTime = '2025-12-10T00:00:00Z'; // Midnight UTC = 7 PM Eastern (prev day)
      const result = formatTime(utcTime, 'America/New_York');
      expect(result).toMatch(/7:00 PM/);
    });
  });

  describe('getStartOfDay (timezone-aware)', () => {
    test('should return midnight in specified timezone', () => {
      // Feb 4, 2026 noon UTC
      const date = new Date('2026-02-04T12:00:00Z');
      const result = getStartOfDay(date, 'America/New_York');

      // Midnight Feb 4 Eastern = 5 AM Feb 4 UTC (EST is UTC-5)
      expect(result.toISOString()).toBe('2026-02-04T05:00:00.000Z');
    });

    test('should handle date near midnight correctly', () => {
      // 3 AM UTC on Feb 4 = 10 PM Feb 3 Eastern
      const date = new Date('2026-02-04T03:00:00Z');
      const result = getStartOfDay(date, 'America/New_York');

      // Start of Feb 3 Eastern = 5 AM Feb 3 UTC
      expect(result.toISOString()).toBe('2026-02-03T05:00:00.000Z');
    });

    test('should work with Pacific timezone', () => {
      const date = new Date('2026-02-04T12:00:00Z');
      const result = getStartOfDay(date, 'America/Los_Angeles');

      // Midnight Feb 4 Pacific = 8 AM Feb 4 UTC (PST is UTC-8)
      expect(result.toISOString()).toBe('2026-02-04T08:00:00.000Z');
    });
  });

  describe('getEndOfDay (timezone-aware)', () => {
    test('should return midnight of next day in specified timezone', () => {
      const date = new Date('2026-02-04T12:00:00Z');
      const result = getEndOfDay(date, 'America/New_York');

      // Midnight Feb 5 Eastern = 5 AM Feb 5 UTC
      expect(result.toISOString()).toBe('2026-02-05T05:00:00.000Z');
    });

    test('should be exactly 24 hours after getStartOfDay', () => {
      const date = new Date('2026-02-04T12:00:00Z');
      const start = getStartOfDay(date, 'America/New_York');
      const end = getEndOfDay(date, 'America/New_York');

      const diffMs = end.getTime() - start.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      expect(diffHours).toBe(24);
    });
  });
});
