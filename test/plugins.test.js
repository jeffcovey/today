import fs from 'fs';
import path from 'path';
import { discoverPlugins, getPluginAccess } from '../src/plugin-loader.js';
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
      // access is now derived from commands, not stored in plugin.toml
      const access = getPluginAccess(plugin);
      expect(['read-only', 'write-only', 'read-write', 'none']).toContain(access);
    });

    test('should have read command if not read-only external data', () => {
      // Plugins with read commands should have them defined
      if (plugin.commands?.read) {
        expect(plugin.commands.read).toBeDefined();
      }
      // Read-only plugins without read are valid (e.g., apple-health-auto-export)
      // They provide AI instructions for querying external data
    });

    test('should have read command that exists and is executable if defined', () => {
      // Skip if no read command (read-only plugins)
      if (!plugin.commands?.read) {
        return;
      }
      const readPath = path.join(plugin._path, plugin.commands.read);
      expect(fs.existsSync(readPath)).toBe(true);

      const stats = fs.statSync(readPath);
      // Check if file has execute permission (owner, group, or other)
      const isExecutable = (stats.mode & 0o111) !== 0;
      expect(isExecutable).toBe(true);
    });

    test('should have a schema defined for its type if it stores data', () => {
      // Only plugins that read and store data need schemas
      // Utility plugins don't store data, they just run cleanup operations
      if (!plugin.commands?.read || plugin.type === 'utility') {
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
