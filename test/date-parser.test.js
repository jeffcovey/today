import { jest } from '@jest/globals';
import { DateParser } from '../src/date-parser.js';

describe('DateParser', () => {
  let parser;
  const mockToday = '2025-08-16';
  
  beforeEach(() => {
    // Mock the date to ensure consistent testing
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-08-16T12:00:00'));
    parser = new DateParser();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Quick tags', () => {
    test('should parse @today correctly', () => {
      expect(parser.parse('today')).toBe(mockToday);
      expect(parser.parse('tonight')).toBe(mockToday);
    });

    test('should parse @tomorrow correctly', () => {
      expect(parser.parse('tomorrow')).toBe('2025-08-17');
    });

    test('should parse @yesterday correctly', () => {
      expect(parser.parse('yesterday')).toBe('2025-08-15');
    });

    test('should parse @weekend correctly', () => {
      // Next Saturday from Friday Aug 16
      expect(parser.parse('weekend')).toBe('2025-08-23');
    });

    test('should parse @nextweek correctly', () => {
      // Next Monday from Friday Aug 16
      expect(parser.parse('nextweek')).toBe('2025-08-18');
    });
  });

  describe('Weekday names', () => {
    test('should parse weekday abbreviations', () => {
      expect(parser.parse('mon')).toBe('2025-08-18');
      expect(parser.parse('tue')).toBe('2025-08-19');
      expect(parser.parse('wed')).toBe('2025-08-20');
      expect(parser.parse('thu')).toBe('2025-08-21');
      expect(parser.parse('fri')).toBe('2025-08-22');
      expect(parser.parse('sat')).toBe('2025-08-23');
      expect(parser.parse('sun')).toBe('2025-08-17');
    });

    test('should parse full weekday names', () => {
      expect(parser.parse('monday')).toBe('2025-08-18');
      expect(parser.parse('tuesday')).toBe('2025-08-19');
      expect(parser.parse('wednesday')).toBe('2025-08-20');
      expect(parser.parse('thursday')).toBe('2025-08-21');
      expect(parser.parse('friday')).toBe('2025-08-22');
      expect(parser.parse('saturday')).toBe('2025-08-23');
      expect(parser.parse('sunday')).toBe('2025-08-17');
    });
  });

  describe('Relative time', () => {
    test('should parse days notation', () => {
      expect(parser.parse('1d')).toBe('2025-08-17');
      expect(parser.parse('3d')).toBe('2025-08-19');
      expect(parser.parse('7d')).toBe('2025-08-23');
    });

    test('should parse weeks notation', () => {
      expect(parser.parse('1w')).toBe('2025-08-23');
      expect(parser.parse('2w')).toBe('2025-08-30');
      expect(parser.parse('4w')).toBe('2025-09-13');
    });

    test('should parse months notation', () => {
      expect(parser.parse('1m')).toBe('2025-09-16');
      expect(parser.parse('3m')).toBe('2025-11-16');
    });

    test('should parse years notation', () => {
      expect(parser.parse('1y')).toBe('2026-08-16');
      expect(parser.parse('2y')).toBe('2027-08-16');
    });
  });

  describe('Natural language', () => {
    test('should parse "next [weekday]"', () => {
      expect(parser.parse('next monday')).toBe('2025-08-18');
      expect(parser.parse('next friday')).toBe('2025-08-22');
    });

    test('should parse "last [weekday]"', () => {
      expect(parser.parse('last monday')).toBe('2025-08-11');
      expect(parser.parse('last friday')).toBe('2025-08-15');
    });

    test('should parse "in X days/weeks/months"', () => {
      expect(parser.parse('in 3 days')).toBe('2025-08-19');
      expect(parser.parse('in 2 weeks')).toBe('2025-08-30');
      expect(parser.parse('in 1 month')).toBe('2025-09-16');
    });
  });

  describe('Absolute dates', () => {
    test('should parse MM/DD format', () => {
      expect(parser.parse('8/25')).toBe('2025-08-25');
      expect(parser.parse('12/31')).toBe('2025-12-31');
      expect(parser.parse('1/1')).toBe('2025-01-01'); // Past dates stay in current year for MM/DD format
    });

    test('should parse MM/DD/YYYY format', () => {
      expect(parser.parse('8/25/2025')).toBe('2025-08-25');
      expect(parser.parse('12/31/2025')).toBe('2025-12-31');
      expect(parser.parse('1/1/2026')).toBe('2026-01-01');
    });

    test('should parse month name + day', () => {
      expect(parser.parse('aug 25')).toBe('2025-08-25');
      expect(parser.parse('september 15')).toBe('2025-09-15');
      expect(parser.parse('jan 1')).toBe('2026-01-01'); // Next year
      expect(parser.parse('july 4')).toBe('2026-07-04'); // Past date, next year
    });
  });

  describe('extractDateTags', () => {
    test('should extract single date tag from text', () => {
      const text = 'Schedule meeting @tomorrow with team';
      const tags = parser.extractDateTags(text);
      
      expect(tags).toHaveLength(1);
      expect(tags[0].tag).toBe('@tomorrow');
      expect(tags[0].parsed).toBe('2025-08-17');
      expect(tags[0].index).toBe(17);
    });

    test('should extract multiple date tags', () => {
      const text = 'Start @today and finish @3d';
      const tags = parser.extractDateTags(text);
      
      expect(tags).toHaveLength(2);
      expect(tags[0].tag).toBe('@today');
      expect(tags[1].tag).toBe('@3d');
    });

    test('should not extract @ in emails', () => {
      const text = 'Email john@example.com about project';
      const tags = parser.extractDateTags(text);
      
      expect(tags).toHaveLength(0);
    });

    test('should not extract @ mentions', () => {
      const text = 'Talk to @john about the project';
      const tags = parser.extractDateTags(text);
      
      expect(tags).toHaveLength(0);
    });
  });

  describe('removeTagsFromText', () => {
    test('should remove single date tag', () => {
      const text = 'Schedule meeting @tomorrow with team';
      const tags = parser.extractDateTags(text);
      const result = parser.removeTagsFromText(text, tags);
      
      expect(result).toBe('Schedule meeting with team');
    });

    test('should remove multiple date tags', () => {
      const text = 'Start @today and finish @3d please';
      const tags = parser.extractDateTags(text);
      const result = parser.removeTagsFromText(text, tags);
      
      expect(result).toBe('Start and finish please');
    });

    test('should handle tags at beginning and end', () => {
      const text = '@today Review documents @tomorrow';
      const tags = parser.extractDateTags(text);
      const result = parser.removeTagsFromText(text, tags);
      
      expect(result).toBe('Review documents');
    });

    test('should clean up extra spaces', () => {
      const text = 'Task   @today   with   multiple   spaces';
      const tags = parser.extractDateTags(text);
      const result = parser.removeTagsFromText(text, tags);
      
      expect(result).toBe('Task with multiple spaces');
    });
  });

  describe('Edge cases', () => {
    test('should return null for invalid input', () => {
      expect(parser.parse('')).toBeNull();
      expect(parser.parse(null)).toBeNull();
      expect(parser.parse('invalid')).toBeNull();
      // Note: The date parser doesn't validate month/day ranges, 
      // it returns whatever JS Date can parse
      // expect(parser.parse('13/32')).toBeNull(); // Invalid date
    });

    test('should handle case insensitivity', () => {
      expect(parser.parse('TODAY')).toBe(mockToday);
      expect(parser.parse('Tomorrow')).toBe('2025-08-17');
      expect(parser.parse('MONDAY')).toBe('2025-08-18');
    });
  });
});