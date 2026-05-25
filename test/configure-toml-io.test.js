/**
 * Tests for the shared configure-TUI TOML I/O helpers.
 *
 * The headline guarantee being verified here: writeConfigToml uses
 * compare-and-swap, so a stale snapshot from a configure session that
 * opened before an external edit will be refused (not silently overwrite
 * the newer on-disk content).
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readConfigToml,
  writeConfigToml,
  reportConfigConflict,
} from '../src/configure-toml-io.js';

function makeTmpPath() {
  return path.join(os.tmpdir(), `configure-toml-io-${process.pid}-${Math.random().toString(36).slice(2)}.toml`);
}

describe('configure-toml-io', () => {
  let configPath;

  beforeEach(() => {
    configPath = makeTmpPath();
  });

  afterEach(() => {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  });

  describe('readConfigToml', () => {
    test('returns empty config and null raw when the file is missing', () => {
      const { config, raw } = readConfigToml(configPath);
      expect(config).toEqual({});
      expect(raw).toBeNull();
    });

    test('returns parsed config and raw bytes for an existing file', () => {
      const content = 'timezone = "America/New_York"\n\n[profile]\nname = "Test"\n';
      fs.writeFileSync(configPath, content);

      const { config, raw } = readConfigToml(configPath);
      expect(config.timezone).toBe('America/New_York');
      expect(config.profile.name).toBe('Test');
      expect(raw).toBe(content);
    });

    test('rethrows parse errors for invalid TOML content', () => {
      fs.writeFileSync(configPath, 'timezone = "UTC"\nbroken = [\n');
      expect(() => readConfigToml(configPath)).toThrow();
    });
  });

  describe('writeConfigToml', () => {
    test('writes header + TOML and reports no conflict when baseline matches', () => {
      const config = { timezone: 'UTC' };
      const { content, conflict } = writeConfigToml(configPath, config, null);
      expect(conflict).toBe(false);
      expect(content.startsWith('# Configuration for Today system')).toBe(true);
      expect(content).toContain('timezone = "UTC"');
      expect(fs.readFileSync(configPath, 'utf8')).toBe(content);
    });

    test('converts multi-line ai_instructions to triple-quoted strings', () => {
      const config = {
        plugins: { test: { default: { ai_instructions: 'Line 1\nLine 2' } } },
      };
      const { conflict } = writeConfigToml(configPath, config, null);
      expect(conflict).toBe(false);

      const written = fs.readFileSync(configPath, 'utf8');
      expect(written).toContain('ai_instructions = """');
      expect(written).toContain('Line 1');
      expect(written).toContain('Line 2');
    });

    test('refuses to overwrite when on-disk content drifted from the baseline', () => {
      const baseline = 'timezone = "UTC"\n';
      fs.writeFileSync(configPath, baseline);

      // Simulate an external writer (eg. Unison) merging in a change
      // after the TUI read the file.
      const drifted = 'timezone = "UTC"\nlocation = "Oakland Park"\n';
      fs.writeFileSync(configPath, drifted);

      const config = { timezone: 'America/New_York' };
      const { conflict } = writeConfigToml(configPath, config, baseline);

      expect(conflict).toBe(true);
      // On-disk file is the externally-merged content, untouched.
      expect(fs.readFileSync(configPath, 'utf8')).toBe(drifted);
    });

    test('creates the file on first write when baseline is null', () => {
      const config = { timezone: 'UTC' };
      const { conflict } = writeConfigToml(configPath, config, null);
      expect(conflict).toBe(false);
      expect(fs.existsSync(configPath)).toBe(true);
    });

    test('treats a since-deleted file as a conflict when baseline was non-empty', () => {
      const baseline = 'timezone = "UTC"\n';
      // File never existed — caller thinks it had content, but disk says
      // otherwise. CAS must refuse.
      const config = { timezone: 'America/New_York' };
      const { conflict } = writeConfigToml(configPath, config, baseline);
      expect(conflict).toBe(true);
      expect(fs.existsSync(configPath)).toBe(false);
    });

    test('round-trips a read + write when nothing else touches the file', () => {
      const initial = 'timezone = "America/New_York"\n';
      fs.writeFileSync(configPath, initial);

      const { config, raw } = readConfigToml(configPath);
      config.location = 'Oakland Park, Florida';

      const { conflict } = writeConfigToml(configPath, config, raw);
      expect(conflict).toBe(false);

      const reloaded = readConfigToml(configPath);
      expect(reloaded.config.timezone).toBe('America/New_York');
      expect(reloaded.config.location).toBe('Oakland Park, Florida');
    });
  });

  describe('reportConfigConflict', () => {
    test('uses the config filename in the conflict line and includes full path + source', () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      reportConfigConflict('/tmp/today.toml', 'configure');
      const joined = errSpy.mock.calls.map(args => args.join(' ')).join('\n');
      expect(joined).toContain('today.toml changed externally');
      expect(joined).toContain('/tmp/today.toml');
      expect(joined).toContain('configure');
      errSpy.mockRestore();
    });
  });
});
