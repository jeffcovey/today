import { findTimezone, isValidTimezone, getAvailableTimezones } from '../src/timezone-resolver.js';

describe('timezone-resolver', () => {
  describe('getAvailableTimezones', () => {
    test('should return an array of timezones', () => {
      const timezones = getAvailableTimezones();
      expect(Array.isArray(timezones)).toBe(true);
      expect(timezones.length).toBeGreaterThan(100);
    });

    test('should include common timezones', () => {
      const timezones = getAvailableTimezones();
      expect(timezones).toContain('America/New_York');
      expect(timezones).toContain('Europe/London');
      expect(timezones).toContain('Asia/Tokyo');
    });
  });

  describe('isValidTimezone', () => {
    test('should return true for valid IANA timezones', () => {
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('Europe/London')).toBe(true);
      expect(isValidTimezone('Asia/Tokyo')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
    });

    test('should return false for invalid timezones', () => {
      expect(isValidTimezone('Invalid/Timezone')).toBe(false);
      expect(isValidTimezone('foo')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
    });
  });

  describe('findTimezone', () => {
    describe('direct timezone lookup', () => {
      test('should return valid IANA timezones unchanged', () => {
        expect(findTimezone('America/New_York')).toBe('America/New_York');
        expect(findTimezone('Europe/Paris')).toBe('Europe/Paris');
        expect(findTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
      });
    });

    describe('timezone abbreviations', () => {
      test('should resolve US timezone abbreviations', () => {
        expect(findTimezone('EST')).toBe('America/New_York');
        expect(findTimezone('CST')).toBe('America/Chicago');
        expect(findTimezone('MST')).toBe('America/Denver');
        expect(findTimezone('PST')).toBe('America/Los_Angeles');
      });

      test('should resolve European timezone abbreviations', () => {
        expect(findTimezone('bst')).toBe('Europe/London');
        expect(findTimezone('cet')).toBe('Europe/Paris');
        expect(findTimezone('cest')).toBe('Europe/Paris');
      });

      test('should be case-insensitive for abbreviations', () => {
        expect(findTimezone('est')).toBe('America/New_York');
        expect(findTimezone('Est')).toBe('America/New_York');
        expect(findTimezone('pst')).toBe('America/Los_Angeles');
      });
    });

    describe('country/region lookup', () => {
      test('should resolve US/USA', () => {
        expect(findTimezone('us')).toBe('America/New_York');
        expect(findTimezone('usa')).toBe('America/New_York');
      });

      test('should resolve UK/Britain', () => {
        expect(findTimezone('uk')).toBe('Europe/London');
        expect(findTimezone('britain')).toBe('Europe/London');
        expect(findTimezone('england')).toBe('Europe/London');
      });

      test('should resolve countries via library', () => {
        // These use the countries-and-timezones library
        expect(findTimezone('France')).toBe('Europe/Paris');
        expect(findTimezone('Germany')).toBe('Europe/Berlin');
        expect(findTimezone('Japan')).toBe('Asia/Tokyo');
        expect(findTimezone('Australia')).toBe('Antarctica/Macquarie'); // Library returns first tz alphabetically
      });
    });

    describe('city name lookup', () => {
      test('should resolve city names to timezones', () => {
        expect(findTimezone('new york')).toBe('America/New_York');
        expect(findTimezone('los angeles')).toBe('America/Los_Angeles');
        expect(findTimezone('chicago')).toBe('America/Chicago');
        expect(findTimezone('london')).toBe('Europe/London');
        expect(findTimezone('paris')).toBe('Europe/Paris');
        expect(findTimezone('tokyo')).toBe('Asia/Tokyo');
      });

      test('should be case-insensitive for city names', () => {
        expect(findTimezone('NEW YORK')).toBe('America/New_York');
        expect(findTimezone('Tokyo')).toBe('Asia/Tokyo');
      });
    });

    describe('edge cases', () => {
      test('should handle whitespace', () => {
        expect(findTimezone('  EST  ')).toBe('America/New_York');
      });

      test('should return input for unknown queries', () => {
        expect(findTimezone('unknown_place')).toBe('unknown_place');
      });
    });
  });
});
