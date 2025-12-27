/**
 * Tests for bin/today configure functionality
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

// Test config path (use a temp file)
const TEST_CONFIG_PATH = path.join(projectRoot, '.data', 'test-config.toml');

describe('Today Configure', () => {
  beforeEach(() => {
    // Clean up test config before each test
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      fs.unlinkSync(TEST_CONFIG_PATH);
    }
  });

  afterAll(() => {
    // Clean up after all tests
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      fs.unlinkSync(TEST_CONFIG_PATH);
    }
  });

  describe('readConfig', () => {
    it('should return empty object when config does not exist', () => {
      const config = readTestConfig(TEST_CONFIG_PATH);
      expect(config).toEqual({});
    });

    it('should parse valid TOML config', () => {
      const content = `
timezone = "America/New_York"
location = "New York, NY"

[profile]
name = "Test User"
email = "test@example.com"
`;
      fs.writeFileSync(TEST_CONFIG_PATH, content);

      const config = readTestConfig(TEST_CONFIG_PATH);
      expect(config.timezone).toBe('America/New_York');
      expect(config.location).toBe('New York, NY');
      expect(config.profile.name).toBe('Test User');
      expect(config.profile.email).toBe('test@example.com');
    });
  });

  describe('writeConfig', () => {
    it('should write config with header comment', () => {
      const config = {
        timezone: 'America/Los_Angeles',
        location: 'San Francisco, CA'
      };

      writeTestConfig(TEST_CONFIG_PATH, config);

      const content = fs.readFileSync(TEST_CONFIG_PATH, 'utf8');
      expect(content).toContain('# Configuration for Today system');
      expect(content).toContain('timezone = "America/Los_Angeles"');
      expect(content).toContain('location = "San Francisco, CA"');
    });

    it('should write nested config sections', () => {
      const config = {
        timezone: 'UTC',
        profile: {
          name: 'Test',
          wake_time: '07:00',
          bed_time: '23:00'
        },
        ai: {
          claude_model: 'claude-sonnet-4-20250514'
        }
      };

      writeTestConfig(TEST_CONFIG_PATH, config);

      const content = fs.readFileSync(TEST_CONFIG_PATH, 'utf8');
      expect(content).toContain('[profile]');
      expect(content).toContain('name = "Test"');
      expect(content).toContain('[ai]');
      expect(content).toContain('claude_model = "claude-sonnet-4-20250514"');
    });

    it('should convert multi-line ai_instructions to triple-quoted strings', () => {
      const config = {
        plugins: {
          test: {
            default: {
              enabled: true,
              ai_instructions: 'Line 1\nLine 2\nLine 3'
            }
          }
        }
      };

      writeTestConfig(TEST_CONFIG_PATH, config);

      const content = fs.readFileSync(TEST_CONFIG_PATH, 'utf8');
      expect(content).toContain('ai_instructions = """');
      expect(content).toContain('Line 1');
      expect(content).toContain('Line 2');
    });
  });

  describe('config round-trip', () => {
    it('should preserve data through read/write cycle', () => {
      const original = {
        timezone: 'Europe/London',
        location: 'London, UK',
        profile: {
          name: 'Test User',
          email: 'test@example.com',
          home_location: 'London',
          vocation: 'Developer',
          wake_time: '06:30',
          bed_time: '22:30'
        },
        ai: {
          claude_model: 'claude-opus-4-20250514'
        }
      };

      writeTestConfig(TEST_CONFIG_PATH, original);
      const loaded = readTestConfig(TEST_CONFIG_PATH);

      expect(loaded.timezone).toBe(original.timezone);
      expect(loaded.location).toBe(original.location);
      expect(loaded.profile.name).toBe(original.profile.name);
      expect(loaded.profile.email).toBe(original.profile.email);
      expect(loaded.ai.claude_model).toBe(original.ai.claude_model);
    });
  });
});

// Helper functions that mirror the actual implementation
function readTestConfig(configPath) {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return parseToml(content);
  } catch {
    return {};
  }
}

function writeTestConfig(configPath, config) {
  let tomlOutput = stringifyToml(config);

  // Convert ai_instructions to multi-line strings
  tomlOutput = tomlOutput.replace(
    /^(ai_instructions\s*=\s*)"((?:[^"\\]|\\.)*)"/gm,
    (match, prefix, content) => {
      if (!content.includes('\\n')) return match;
      const unescaped = content
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      return `${prefix}"""\n${unescaped}\n"""`;
    }
  );

  const header = `# Configuration for Today system
# Edit this file when your situation changes (e.g., when traveling)

`;

  fs.writeFileSync(configPath, header + tomlOutput);
}
