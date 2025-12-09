import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock the config module
jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn()
}));

// Import after mocking
const { getFullConfig } = await import('../src/config.js');
const {
  discoverPlugins,
  getPluginSources,
  getEnabledPlugins
} = await import('../src/plugin-loader.js');

describe('Plugin Loader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('discoverPlugins', () => {
    test('should discover time-tracking plugin from plugins directory', async () => {
      const plugins = await discoverPlugins();

      expect(plugins.size).toBeGreaterThan(0);
      expect(plugins.has('time-tracking')).toBe(true);
    });

    test('should return plugin metadata from plugin.toml', async () => {
      const plugins = await discoverPlugins();
      const timeTracking = plugins.get('time-tracking');

      expect(timeTracking).toHaveProperty('name', 'time-tracking');
      expect(timeTracking).toHaveProperty('displayName', 'Time Tracking');
      expect(timeTracking).toHaveProperty('type', 'time-entries');
      expect(timeTracking).toHaveProperty('access', 'read-write');
      expect(timeTracking).toHaveProperty('commands');
      expect(timeTracking.commands).toHaveProperty('sync');
    });

    test('should include plugin path in metadata', async () => {
      const plugins = await discoverPlugins();
      const timeTracking = plugins.get('time-tracking');

      expect(timeTracking).toHaveProperty('_path');
      expect(timeTracking._path).toContain('plugins/time-tracking');
    });
  });

  describe('getPluginSources', () => {
    test('should return empty array when plugin not configured', () => {
      getFullConfig.mockReturnValue({});

      const sources = getPluginSources('time-tracking');

      expect(sources).toEqual([]);
    });

    test('should return empty array when no plugins section', () => {
      getFullConfig.mockReturnValue({ timezone: 'America/New_York' });

      const sources = getPluginSources('time-tracking');

      expect(sources).toEqual([]);
    });

    test('should return sources with enabled = true', () => {
      getFullConfig.mockReturnValue({
        plugins: {
          'time-tracking': {
            local: { enabled: true, days_to_sync: 365 },
            work: { enabled: true, directory: 'vault/logs/work' }
          }
        }
      });

      const sources = getPluginSources('time-tracking');

      expect(sources).toHaveLength(2);
      expect(sources[0]).toEqual({
        sourceName: 'local',
        config: { enabled: true, days_to_sync: 365 }
      });
      expect(sources[1]).toEqual({
        sourceName: 'work',
        config: { enabled: true, directory: 'vault/logs/work' }
      });
    });

    test('should exclude sources with enabled = false', () => {
      getFullConfig.mockReturnValue({
        plugins: {
          'time-tracking': {
            local: { enabled: true },
            disabled: { enabled: false }
          }
        }
      });

      const sources = getPluginSources('time-tracking');

      expect(sources).toHaveLength(1);
      expect(sources[0].sourceName).toBe('local');
    });

    test('should exclude sources without enabled = true (opt-in)', () => {
      getFullConfig.mockReturnValue({
        plugins: {
          'time-tracking': {
            local: { enabled: true },
            implicit: { days_to_sync: 30 }  // no enabled field
          }
        }
      });

      const sources = getPluginSources('time-tracking');

      expect(sources).toHaveLength(1);
      expect(sources[0].sourceName).toBe('local');
    });
  });

  describe('getEnabledPlugins', () => {
    test('should return empty array when no plugins configured', async () => {
      getFullConfig.mockReturnValue({});

      const enabled = await getEnabledPlugins();

      expect(enabled).toEqual([]);
    });

    test('should return plugins with their sources', async () => {
      getFullConfig.mockReturnValue({
        plugins: {
          'time-tracking': {
            local: { enabled: true, days_to_sync: 365 }
          }
        }
      });

      const enabled = await getEnabledPlugins();

      expect(enabled).toHaveLength(1);
      expect(enabled[0].plugin.name).toBe('time-tracking');
      expect(enabled[0].sources).toHaveLength(1);
      expect(enabled[0].sources[0].sourceName).toBe('local');
    });
  });
});
