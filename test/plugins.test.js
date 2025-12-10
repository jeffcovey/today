import fs from 'fs';
import path from 'path';
import { discoverPlugins } from '../src/plugin-loader.js';
import { getSchema } from '../src/plugin-schemas.js';

// Discover plugins before tests run
const plugins = await discoverPlugins();
const pluginNames = Array.from(plugins.keys());

describe('All Plugins', () => {
  test('should have at least one plugin', () => {
    expect(plugins.size).toBeGreaterThan(0);
  });

  // Dynamically create tests for each discovered plugin
  describe.each(pluginNames)('plugin %s', (pluginName) => {
    const plugin = plugins.get(pluginName);

    test('should have required metadata', () => {
      expect(plugin.name).toBe(pluginName);
      expect(plugin.displayName).toBeDefined();
      expect(plugin.description).toBeDefined();
      expect(plugin.type).toBeDefined();
      expect(plugin.access).toBeDefined();
      expect(['read-only', 'write-only', 'read-write']).toContain(plugin.access);
    });

    test('should have sync command if not read-only external data', () => {
      // Plugins with sync commands should have them defined
      if (plugin.commands?.sync) {
        expect(plugin.commands.sync).toBeDefined();
      }
      // Read-only plugins without sync are valid (e.g., apple-health-auto-export)
      // They provide AI instructions for querying external data
    });

    test('should have sync command that exists and is executable if defined', () => {
      // Skip if no sync command (read-only plugins)
      if (!plugin.commands?.sync) {
        return;
      }
      const syncPath = path.join(plugin._path, plugin.commands.sync);
      expect(fs.existsSync(syncPath)).toBe(true);

      const stats = fs.statSync(syncPath);
      // Check if file has execute permission (owner, group, or other)
      const isExecutable = (stats.mode & 0o111) !== 0;
      expect(isExecutable).toBe(true);
    });

    test('should have a schema defined for its type if it has sync', () => {
      // Only plugins that sync data need schemas
      if (!plugin.commands?.sync) {
        return;
      }
      const schema = getSchema(plugin.type);
      expect(schema).not.toBeNull();
    });

    test('should have settings if it has config options', () => {
      // settings is optional, but if present should be an object
      if (plugin.settings) {
        expect(typeof plugin.settings).toBe('object');
      }
    });
  });
});
