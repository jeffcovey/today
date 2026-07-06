// Frontmatter parsing for markdown pages.
//
// AI-generated plan files sometimes contain YAML that js-yaml can't parse
// (e.g. an unquoted "key: value" colon inside a narrative summary). These
// helpers parse valid frontmatter strictly and fall back to a lenient,
// best-effort recovery so a single bad character never dumps raw frontmatter
// into the page or breaks the Properties section / =this.* lookups.
// Namespace import: js-yaml v5 ships native ESM with named exports and no
// default export, so `import yaml from 'js-yaml'` would throw. This form works
// on both v4 and v5.
import * as yaml from 'js-yaml';

// Strip surrounding quotes from a lenient-parsed scalar value.
export function stripYamlQuotes(value) {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2] : trimmed;
}

// Coerce a lenient-parsed scalar to a number when it clearly is one,
// otherwise leave it as a string (dates stay strings, matching js-yaml v5).
export function coerceYamlScalar(value) {
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

// Keys that would pollute Object.prototype if assigned; skipped by the
// lenient parser since it handles untrusted/malformed frontmatter.
const UNSAFE_FRONTMATTER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Best-effort frontmatter parser used only when strict YAML parsing fails
// (e.g. an AI-written summary containing an unquoted "key: value" colon).
// Handles the flat "key: value" + simple "- item" list shape our frontmatter
// uses, taking values as raw text (with light numeric coercion) so stray
// colons can't break it.
export function parseFrontmatterLenient(yamlText) {
  const properties = {};
  let currentArrayKey = null;

  for (const rawLine of yamlText.split('\n')) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;

    const arrayItem = rawLine.match(/^\s+-\s+(.*)$/);
    if (arrayItem && currentArrayKey) {
      properties[currentArrayKey].push(stripYamlQuotes(arrayItem[1]));
      continue;
    }

    const keyValue = rawLine.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (keyValue) {
      const [, key, value] = keyValue;
      if (UNSAFE_FRONTMATTER_KEYS.has(key)) {
        currentArrayKey = null;
        continue;
      }
      if (value === '') {
        // Blank value: start of a list (or a nested block we can't recover).
        currentArrayKey = key;
        properties[key] = [];
      } else {
        currentArrayKey = null;
        properties[key] = coerceYamlScalar(stripYamlQuotes(value));
      }
    }
  }

  return Object.keys(properties).length > 0 ? properties : null;
}

// Parse YAML frontmatter from markdown content. Returns the parsed properties
// (null when there is no frontmatter or nothing could be recovered) and the
// body with the frontmatter block removed.
export function parseFrontmatter(content) {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { properties: null, contentWithoutFrontmatter: content };
  }

  // Always strip the frontmatter block from the body so it never renders as
  // page text, even when parsing below fails.
  const contentWithoutFrontmatter = content.replace(frontmatterRegex, '');

  try {
    const properties = yaml.load(match[1]);
    return { properties, contentWithoutFrontmatter };
  } catch (error) {
    // Just log the message, not the full error object (too verbose for vault scanning)
    console.error('Error parsing YAML frontmatter:', error.message || error);
    // Recover what we can so the Properties section and =this.* still work
    // instead of dumping raw frontmatter into the page.
    return { properties: parseFrontmatterLenient(match[1]), contentWithoutFrontmatter };
  }
}
