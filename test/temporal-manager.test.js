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
      createPage: jest.fn(),
      notion: {
        pages: {
          create: jest.fn().mockResolvedValue({ id: 'new-page-id' })
        },
        databases: {
          retrieve: jest.fn().mockResolvedValue({
            properties: {
              Date: { type: 'date' },
              Name: { type: 'title' }
            }
          })
        }
      }
    };

    mockCache = {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      db: {
        prepare: jest.fn().mockReturnValue({
          run: jest.fn()
        })
      }
    };

    manager = new TemporalManager(mockNotionAPI, mockCache);
  });

  describe('Constructor', () => {
    test('should initialize with notionAPI and cache', () => {
      expect(manager.notionAPI).toBe(mockNotionAPI);
      expect(manager.cache).toBe(mockCache);
    });
  });

  describe('createMissingDaysAndWeeks', () => {
    test('should handle missing databases gracefully', async () => {
      // Setup: All databases fail to load
      mockNotionAPI.getDaysDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getWeeksDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getMonthsDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getQuartersDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getYearsDatabase.mockRejectedValue(new Error('DB not found'));

      const spy = jest.spyOn(console, 'log').mockImplementation();
      
      // Should complete without error when all DBs are missing
      await manager.createMissingDaysAndWeeks();
      
      // Should log completion message
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Successfully created missing temporal entries'));
      
      spy.mockRestore();
    });

    test('should handle partial database availability', async () => {
      // Only Days and Weeks databases exist
      mockNotionAPI.getDaysDatabase.mockResolvedValue({ id: 'days-db-id' });
      mockNotionAPI.getWeeksDatabase.mockResolvedValue({ id: 'weeks-db-id' });
      mockNotionAPI.getMonthsDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getQuartersDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getYearsDatabase.mockRejectedValue(new Error('DB not found'));
      
      // Mock existing weeks to prevent warnings
      const mockWeeks = [
        { id: 'week1', properties: { Date: { date: { start: '2025-08-10' } } } },
        { id: 'week2', properties: { Date: { date: { start: '2025-08-17' } } } }
      ];
      mockNotionAPI.getDatabaseItemsIncremental.mockResolvedValue(mockWeeks);

      const spy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      await manager.createMissingDaysAndWeeks();
      
      // Should log date range
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Creating missing temporal entries'));
      
      // Should call getDatabaseItemsIncremental for existing databases
      expect(mockNotionAPI.getDatabaseItemsIncremental).toHaveBeenCalled();
      
      spy.mockRestore();
      warnSpy.mockRestore();
    });

    test('should use default date range when not specified', async () => {
      mockNotionAPI.getDaysDatabase.mockResolvedValue({ id: 'days-db-id' });
      mockNotionAPI.getWeeksDatabase.mockResolvedValue({ id: 'weeks-db-id' });
      mockNotionAPI.getMonthsDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getQuartersDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getYearsDatabase.mockRejectedValue(new Error('DB not found'));
      
      // Mock existing weeks for default date range
      const mockWeeks = [
        { id: 'week1', properties: { Date: { date: { start: '2025-08-03' } } } },
        { id: 'week2', properties: { Date: { date: { start: '2025-08-10' } } } },
        { id: 'week3', properties: { Date: { date: { start: '2025-08-17' } } } },
        { id: 'week4', properties: { Date: { date: { start: '2025-08-24' } } } }
      ];
      mockNotionAPI.getDatabaseItemsIncremental.mockResolvedValue(mockWeeks);

      const spy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      await manager.createMissingDaysAndWeeks();
      
      // Should log date range with default 7 days before and after
      const logCall = spy.mock.calls[0][0];
      expect(logCall).toContain('Creating missing temporal entries');
      expect(logCall).toMatch(/\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
      
      spy.mockRestore();
      warnSpy.mockRestore();
    });

    test('should use custom date range when specified', async () => {
      mockNotionAPI.getDaysDatabase.mockResolvedValue({ id: 'days-db-id' });
      mockNotionAPI.getWeeksDatabase.mockResolvedValue({ id: 'weeks-db-id' });
      mockNotionAPI.getMonthsDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getQuartersDatabase.mockRejectedValue(new Error('DB not found'));
      mockNotionAPI.getYearsDatabase.mockRejectedValue(new Error('DB not found'));
      
      // Mock existing weeks for January 2024
      const mockWeeks = [
        { id: 'week1', properties: { Date: { date: { start: '2023-12-31' } } } },
        { id: 'week2', properties: { Date: { date: { start: '2024-01-07' } } } },
        { id: 'week3', properties: { Date: { date: { start: '2024-01-14' } } } },
        { id: 'week4', properties: { Date: { date: { start: '2024-01-21' } } } },
        { id: 'week5', properties: { Date: { date: { start: '2024-01-28' } } } },
        { id: 'week6', properties: { Date: { date: { start: '2024-02-04' } } } }
      ];
      mockNotionAPI.getDatabaseItemsIncremental.mockResolvedValue(mockWeeks);

      const spy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      
      await manager.createMissingDaysAndWeeks(startDate, endDate);
      
      // Should log the custom date range
      const logCall = spy.mock.calls[0][0];
      expect(logCall).toContain('2024-01-01');
      expect(logCall).toContain('2024-01-31');
      
      spy.mockRestore();
      warnSpy.mockRestore();
    });
  });
});