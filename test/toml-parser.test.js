import { parseTOML, getNestedValue } from '../src/toml-parser.js';

describe('toml-parser', () => {
  describe('parseTOML', () => {
    test('should parse top-level key-value pairs', () => {
      const toml = `
name = "test"
count = 42
enabled = true
`;
      const config = parseTOML(toml);
      expect(config.name).toBe('test');
      expect(config.count).toBe(42);
      expect(config.enabled).toBe(true);
    });

    test('should parse sections', () => {
      const toml = `
[profile]
name = "John"
age = 30

[settings]
theme = "dark"
`;
      const config = parseTOML(toml);
      expect(config.profile.name).toBe('John');
      expect(config.profile.age).toBe(30);
      expect(config.settings.theme).toBe('dark');
    });

    test('should parse nested sections', () => {
      const toml = `
[database.connection]
host = "localhost"
port = 5432
`;
      const config = parseTOML(toml);
      expect(config.database.connection.host).toBe('localhost');
      expect(config.database.connection.port).toBe(5432);
    });

    test('should ignore comments', () => {
      const toml = `
# This is a comment
name = "test"  # inline comment
# Another comment
value = 123
`;
      const config = parseTOML(toml);
      expect(config.name).toBe('test');
      expect(config.value).toBe(123);
    });

    test('should handle empty lines', () => {
      const toml = `
name = "test"

value = 42

[section]

key = "value"
`;
      const config = parseTOML(toml);
      expect(config.name).toBe('test');
      expect(config.value).toBe(42);
      expect(config.section.key).toBe('value');
    });

    test('should handle realistic config file', () => {
      const toml = `
# Main configuration
timezone = "America/New_York"

[profile]
name = "John Doe"
email = "john@example.com"
wake_time = "06:00"
bed_time = "22:00"

[stages]
monday = "front"
tuesday = "off"
wednesday = "front"
thursday = "back"
friday = "off"
saturday = "front"
sunday = "back"

[ai]
claude_model = "claude-sonnet-4-20250514"
`;
      const config = parseTOML(toml);
      expect(config.timezone).toBe('America/New_York');
      expect(config.profile.name).toBe('John Doe');
      expect(config.profile.email).toBe('john@example.com');
      expect(config.stages.monday).toBe('front');
      expect(config.stages.tuesday).toBe('off');
      expect(config.ai.claude_model).toBe('claude-sonnet-4-20250514');
    });

    test('should parse arrays', () => {
      const toml = `
colors = ["red", "green", "blue"]
numbers = [1, 2, 3]
`;
      const config = parseTOML(toml);
      expect(config.colors).toEqual(['red', 'green', 'blue']);
      expect(config.numbers).toEqual([1, 2, 3]);
    });
  });

  describe('getNestedValue', () => {
    const config = {
      name: 'test',
      profile: {
        name: 'John',
        contact: {
          email: 'john@example.com',
        },
      },
      list: [1, 2, 3],
    };

    test('should get top-level values', () => {
      expect(getNestedValue(config, 'name')).toBe('test');
    });

    test('should get nested values with dot notation', () => {
      expect(getNestedValue(config, 'profile.name')).toBe('John');
      expect(getNestedValue(config, 'profile.contact.email')).toBe('john@example.com');
    });

    test('should return undefined for non-existent keys', () => {
      expect(getNestedValue(config, 'nonexistent')).toBeUndefined();
      expect(getNestedValue(config, 'profile.nonexistent')).toBeUndefined();
      expect(getNestedValue(config, 'profile.contact.phone')).toBeUndefined();
    });

    test('should get array values', () => {
      expect(getNestedValue(config, 'list')).toEqual([1, 2, 3]);
    });

    test('should get entire nested objects', () => {
      expect(getNestedValue(config, 'profile.contact')).toEqual({ email: 'john@example.com' });
    });
  });
});
