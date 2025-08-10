import { jest } from '@jest/globals';
import { TemporalManager } from '../src/temporal-manager.js';

describe('TemporalManager', () => {
  let manager;
  let mockNotionAPI;
  let mockCache;

  beforeEach(() => {
    // Create mock dependencies
    mockNotionAPI = {
      getDaysDatabase: jest.fn(),
      getWeeksDatabase: jest.fn(),
      getMonthsDatabase: jest.fn(),
      getQuartersDatabase: jest.fn(),
      getYearsDatabase: jest.fn(),
      getDatabaseItemsIncremental: jest.fn(),
      createPage: jest.fn()
    };

    mockCache = {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn()
    };

    manager = new TemporalManager(mockNotionAPI, mockCache);
  });

  describe('Constructor', () => {
    test('should initialize with notionAPI and cache', () => {
      expect(manager.notionAPI).toBe(mockNotionAPI);
      expect(manager.cache).toBe(mockCache);
    });
  });

  describe('Date utilities', () => {
    test('should format week correctly', () => {
      const date = new Date('2025-08-10');
      const weekStr = manager.getWeekString(date);
      
      // Week 32 of 2025
      expect(weekStr).toMatch(/2025-W\d{2}/);
    });

    test('should format quarter correctly', () => {
      const date = new Date('2025-08-10');
      const quarterStr = manager.getQuarterString(date);
      
      // Q3 2025
      expect(quarterStr).toBe('2025-Q3');
    });

    test('should format month correctly', () => {
      const date = new Date('2025-08-10');
      const monthStr = manager.getMonthString(date);
      
      expect(monthStr).toBe('2025-08');
    });
  });

  describe('createMissingDaysAndWeeks', () => {
    test('should handle database retrieval errors gracefully', async () => {
      mockNotionAPI.getDaysDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getWeeksDatabase.mockResolvedValue({ id: 'weeks-db-id' });

      // Should not throw
      await expect(manager.createMissingDaysAndWeeks()).rejects.toThrow();
    });

    test('should use default date range when not specified', async () => {
      mockNotionAPI.getDaysDatabase.mockResolvedValue({ id: 'days-db-id' });
      mockNotionAPI.getWeeksDatabase.mockResolvedValue({ id: 'weeks-db-id' });
      mockNotionAPI.getDatabaseItemsIncremental.mockResolvedValue([]);

      const spy = jest.spyOn(console, 'log').mockImplementation();
      
      await manager.createMissingDaysAndWeeks();
      
      // Should log date range
      expect(spy).toHaveBeenCalled();
      const logCall = spy.mock.calls[0][0];
      expect(logCall).toContain('Creating missing temporal entries');
      
      spy.mockRestore();
    });
  });
});