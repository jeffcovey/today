/**
 * Regression tests for issue #472 — `bin/plugins configure` destroyed today.toml.
 *
 * The old `writeConfig()` in bin/plugins stripped existing plugin sections with a
 * regex over TOML *text*:
 *
 *   /^#?\s*\[plugins\.[^\]]+\][^\[]*(?=\n#?\s*\[|$)/gm
 *
 * `[^\[]*` cannot cross a `[`, so any section whose values contained a bracket —
 * an array, or a markdown link inside a multi-line string — was only partially
 * removed, orphaning the remaining keys. `$` under /m matched end-of-line rather
 * than end-of-file, making the match boundary effectively arbitrary.
 *
 * These tests pin the invariant that matters: a save must never lose or reparent
 * configuration, whatever the section ordering or the contents of the values.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseToml } from 'smol-toml';
import { readConfigToml, writeConfigToml } from '../src/configure-toml-io.js';

// Flatten to fully-qualified leaf paths, so a key that silently reparents into a
// different table registers as both a loss and an addition.
function leafKeys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leafKeys(v, key));
    else out.push(key);
  }
  return out.sort();
}

let tmpDir;
let configPath;
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-toml-'));
  configPath = path.join(tmpDir, 'today.toml');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The exact shape that broke: plugin sections ahead of other sections, with
// bracketed content in both an array and a multi-line string.
const HOSTILE_CONFIG = `timezone = "America/New_York"
location = "Oakland Park, Florida"

[plugins.hosting.side-room]
additional_urls = [ "https://example.com/rooms/1", "https://example.com/rooms/2" ]
calendar_source = "public-calendars/side-room-cal"
status = "Dirty"

[plugins.markdown-tasks.local]
enabled = true
ai_instructions = """
Priority emojis and bracketed markers appear in task text:
- [Priority: Medium] and [bug] labels
- Markdown links like [the docs](https://example.com/docs)
"""

[plugins.github-issues.ogm]
enabled = true
repository = "OlderGay-Men/OlderGay.Men"
limit = 500

[profile]
name = "Test User"
wake_time = "05:30"

[ai]
provider = "anthropic"
`;

describe('today.toml write integrity (issue #472)', () => {
  test('saving a plugin source preserves every existing key', () => {
    fs.writeFileSync(configPath, HOSTILE_CONFIG);
    const before = leafKeys(parseToml(HOSTILE_CONFIG));

    const { config, raw } = readConfigToml(configPath);
    config.plugins['ynab-api'] = { personal: { enabled: true, retention_days: 365 } };
    const { conflict } = writeConfigToml(configPath, config, raw);
    expect(conflict).toBe(false);

    const after = leafKeys(parseToml(fs.readFileSync(configPath, 'utf8')));
    expect(after).toEqual(expect.arrayContaining(before));
    expect(before.filter(k => !after.includes(k))).toEqual([]);
  });

  test('the rewritten file still parses', () => {
    fs.writeFileSync(configPath, HOSTILE_CONFIG);
    const { config, raw } = readConfigToml(configPath);
    config.plugins['ynab-api'] = { personal: { enabled: true } };
    writeConfigToml(configPath, config, raw);

    // The original failure surfaced here as:
    //   "trying to redefine an already defined table or value"
    expect(() => parseToml(fs.readFileSync(configPath, 'utf8'))).not.toThrow();
  });

  test('array values containing brackets survive intact', () => {
    fs.writeFileSync(configPath, HOSTILE_CONFIG);
    const { config, raw } = readConfigToml(configPath);
    config.plugins['ynab-api'] = { personal: { enabled: true } };
    writeConfigToml(configPath, config, raw);

    const after = parseToml(fs.readFileSync(configPath, 'utf8'));
    expect(after.plugins.hosting['side-room'].additional_urls).toEqual([
      'https://example.com/rooms/1',
      'https://example.com/rooms/2'
    ]);
    expect(after.plugins.hosting['side-room'].status).toBe('Dirty');
  });

  test('bracketed text inside multi-line strings survives intact', () => {
    fs.writeFileSync(configPath, HOSTILE_CONFIG);
    const { config, raw } = readConfigToml(configPath);
    config.plugins['ynab-api'] = { personal: { enabled: true } };
    writeConfigToml(configPath, config, raw);

    const after = parseToml(fs.readFileSync(configPath, 'utf8'));
    const instructions = after.plugins['markdown-tasks'].local.ai_instructions;
    expect(instructions).toContain('[Priority: Medium]');
    expect(instructions).toContain('[the docs](https://example.com/docs)');
  });

  test('non-plugin sections are never reparented or dropped', () => {
    fs.writeFileSync(configPath, HOSTILE_CONFIG);
    const { config, raw } = readConfigToml(configPath);
    config.plugins['ynab-api'] = { personal: { enabled: true } };
    writeConfigToml(configPath, config, raw);

    const after = parseToml(fs.readFileSync(configPath, 'utf8'));
    expect(after.profile.name).toBe('Test User');
    expect(after.ai.provider).toBe('anthropic');
    expect(after.timezone).toBe('America/New_York');
    // timezone/location are root scalars — they must not migrate into a table
    expect(after.plugins.timezone).toBeUndefined();
    expect(after.profile.timezone).toBeUndefined();
  });

  test('deleting one source leaves the other sources untouched', () => {
    fs.writeFileSync(configPath, HOSTILE_CONFIG);
    const { config, raw } = readConfigToml(configPath);
    delete config.plugins['github-issues'];
    writeConfigToml(configPath, config, raw);

    const after = parseToml(fs.readFileSync(configPath, 'utf8'));
    expect(after.plugins['github-issues']).toBeUndefined();
    expect(after.plugins.hosting['side-room'].status).toBe('Dirty');
    expect(after.plugins['markdown-tasks'].local.enabled).toBe(true);
    expect(after.profile.name).toBe('Test User');
  });

  test('repeated saves are stable — no churn, no drift', () => {
    fs.writeFileSync(configPath, HOSTILE_CONFIG);

    let previous = null;
    for (let i = 0; i < 3; i++) {
      const { config, raw } = readConfigToml(configPath);
      config.plugins['ynab-api'] = { personal: { enabled: true } };
      writeConfigToml(configPath, config, raw);
      const content = fs.readFileSync(configPath, 'utf8');
      if (previous !== null) expect(content).toBe(previous);
      previous = content;
    }
  });

  test('an external edit mid-session is detected, not clobbered', () => {
    fs.writeFileSync(configPath, HOSTILE_CONFIG);
    const { config, raw } = readConfigToml(configPath);

    // Someone else (Unison, another session) rewrites the file after our read
    const external = HOSTILE_CONFIG + '\n[plugins.new-thing.default]\nenabled = true\n';
    fs.writeFileSync(configPath, external);

    config.plugins['ynab-api'] = { personal: { enabled: true } };
    const { conflict } = writeConfigToml(configPath, config, raw);

    expect(conflict).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(external);
  });
});

describe('today.toml writers share the canonical TOML I/O (issue #476)', () => {
  const writers = [
    'src/configure-ui.js',
    'src/deployments-configure-ui.js',
    'src/plugins-configure-ui.js',
    'bin/plugins',
  ];

  test.each(writers)('%s reads and writes through configure-toml-io.js', (relativePath) => {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    expect(source).toContain('readConfigToml');
    expect(source).toContain('writeConfigToml');
  });

  test('plugins-configure-ui does not carry its own TOML serializer anymore', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src', 'plugins-configure-ui.js'), 'utf8');
    expect(source).not.toContain('stringify as stringifyToml');
    expect(source).not.toContain("parse as parseToml");
    expect(source).not.toContain('/^(ai_instructions');
  });
});

describe('the old regex strip (documents why it was removed)', () => {
  // Kept as an executable explanation: this asserts the OLD approach was broken,
  // so nobody reintroduces text-level section surgery.
  const OLD_STRIP = /^#?\s*\[plugins\.[^\]]+\][^\[]*(?=\n#?\s*\[|$)/gm;

  test('mangles sections whose values contain a bracket', () => {
    const stripped = HOSTILE_CONFIG.replace(OLD_STRIP, '');

    // It fails to remove the sections cleanly, leaving orphaned keys behind
    const orphaned = stripped.includes('additional_urls')
      || stripped.includes('calendar_source')
      || stripped.includes('repository');
    expect(orphaned).toBe(true);
  });
});
