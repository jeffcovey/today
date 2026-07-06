import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseFrontmatter,
  parseFrontmatterLenient,
  stripYamlQuotes,
  coerceYamlScalar,
} from '../src/frontmatter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The lenient fallback logs to console.error by design; silence it in tests.
let errorSpy;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe('parseFrontmatter — strict (valid YAML)', () => {
  test('parses valid frontmatter and strips it from the body', () => {
    const content = '---\ntitle: Hello\ncount: 3\n---\n# Body\n\ntext\n';
    const { properties, contentWithoutFrontmatter } = parseFrontmatter(content);
    expect(properties).toEqual({ title: 'Hello', count: 3 });
    expect(contentWithoutFrontmatter).toBe('# Body\n\ntext\n');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('parses list values', () => {
    const content = '---\ngoals:\n  - one\n  - two\n---\nbody\n';
    const { properties } = parseFrontmatter(content);
    expect(properties.goals).toEqual(['one', 'two']);
  });

  test('returns null properties and untouched content when there is no frontmatter', () => {
    const content = '# Just a heading\n\nno frontmatter here\n';
    const { properties, contentWithoutFrontmatter } = parseFrontmatter(content);
    expect(properties).toBeNull();
    expect(contentWithoutFrontmatter).toBe(content);
  });
});

describe('parseFrontmatter — lenient fallback (malformed YAML)', () => {
  // Reproduces the real bug: an unquoted "key: value" colon inside a scalar
  // makes js-yaml throw, which previously dumped raw frontmatter into the page.
  const malformed =
    '---\n' +
    'quarter: Q2\n' +
    'year: 2026\n' +
    'start_date: 2026-04-01\n' +
    'theme: Health, Legacy, and Growth\n' +
    'goals:\n' +
    '  - Finish the weight loss project\n' +
    '  - Launch campaign: target audience and budget\n' +
    'summary: The quarter had genuine warmth: language learning claimed the most hours.\n' +
    '---\n' +
    '# Q2 2026\n\nbody\n';

  test('strips the frontmatter block from the body even though YAML parsing failed', () => {
    const { contentWithoutFrontmatter } = parseFrontmatter(malformed);
    expect(contentWithoutFrontmatter).toBe('# Q2 2026\n\nbody\n');
    expect(contentWithoutFrontmatter).not.toContain('summary:');
    expect(errorSpy).toHaveBeenCalled(); // fallback was triggered
  });

  test('recovers scalar, numeric, and list properties', () => {
    const { properties } = parseFrontmatter(malformed);
    expect(properties.quarter).toBe('Q2');
    expect(properties.year).toBe(2026); // numeric coercion
    expect(properties.start_date).toBe('2026-04-01'); // date stays a string
    expect(properties.theme).toBe('Health, Legacy, and Growth');
    expect(properties.goals).toHaveLength(2);
  });

  test('preserves colons inside recovered values instead of choking on them', () => {
    const { properties } = parseFrontmatter(malformed);
    expect(properties.summary).toBe(
      'The quarter had genuine warmth: language learning claimed the most hours.'
    );
    expect(properties.goals[1]).toBe('Launch campaign: target audience and budget');
  });
});

describe('parseFrontmatterLenient', () => {
  test('returns null when nothing can be recovered', () => {
    expect(parseFrontmatterLenient('')).toBeNull();
    expect(parseFrontmatterLenient('   \n# only a comment\n')).toBeNull();
  });

  test('does not allow prototype pollution from malicious keys', () => {
    const text = [
      '__proto__: polluted',
      'constructor: nope',
      'prototype: nope',
      'safe_key: kept',
    ].join('\n');

    const props = parseFrontmatterLenient(text);

    // Global prototype must be untouched.
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    // Dangerous keys are skipped; only the safe key survives.
    expect(Object.keys(props)).toEqual(['safe_key']);
    expect(props.safe_key).toBe('kept');
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
  });

  test('ignores blank lines and comments', () => {
    const text = '# heading comment\n\nkey: value\n\n# trailing\n';
    expect(parseFrontmatterLenient(text)).toEqual({ key: 'value' });
  });
});

describe('stripYamlQuotes', () => {
  test('removes matching single or double quotes', () => {
    expect(stripYamlQuotes('"hello"')).toBe('hello');
    expect(stripYamlQuotes("'hello'")).toBe('hello');
    expect(stripYamlQuotes('  "spaced"  ')).toBe('spaced');
  });
  test('leaves unquoted or mismatched values alone', () => {
    expect(stripYamlQuotes('plain')).toBe('plain');
    expect(stripYamlQuotes('"mismatch\'')).toBe('"mismatch\'');
  });
});

describe('coerceYamlScalar', () => {
  test('coerces integers and floats, leaves other strings intact', () => {
    expect(coerceYamlScalar('2026')).toBe(2026);
    expect(coerceYamlScalar('-3')).toBe(-3);
    expect(coerceYamlScalar('1.5')).toBe(1.5);
    expect(coerceYamlScalar('2026-04-01')).toBe('2026-04-01'); // date-like stays string
    expect(coerceYamlScalar('Q2')).toBe('Q2');
  });
});

describe('regression: real broken quarterly plan file', () => {
  const realFile = path.join(__dirname, '..', 'vault', 'plans', '2026_Q2_00.md');

  (fs.existsSync(realFile) ? test : test.skip)(
    'recovers properties and strips frontmatter for the real file',
    () => {
      const content = fs.readFileSync(realFile, 'utf8');
      const { properties, contentWithoutFrontmatter } = parseFrontmatter(content);
      expect(properties).not.toBeNull();
      expect(properties.quarter_theme).toBeTruthy();
      expect(Array.isArray(properties.quarter_goals)).toBe(true);
      expect(typeof properties.quarter_summary).toBe('string');
      expect(contentWithoutFrontmatter).not.toContain('quarter_summary:');
    }
  );
});
