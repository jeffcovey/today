import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseToml } from 'smol-toml';
import { readConfigToml, writeConfigToml } from '../src/configure-toml-io.js';
import { setTomlValue, removeTomlTable, findTableRanges } from '../src/toml-edit.js';
import { diffScalarChanges, applyScalarChanges } from '../src/config-diff.js';

// A config with the things a round-trip destroys: comments that explain a past
// failure, deliberate section order, and formatting choices.
const SAMPLE = `# Configuration for Today system
# Edit this file when your situation changes (e.g., when traveling)

timezone = "America/New_York"

[plugins.imap-email.icloud]
enabled = true
host = "imap.mail.me.com"
days_to_sync = 30

[deployments.local.mini.unison]
target = "digitalocean/droplet"
# Guard against the 2026-05-26 nested-clone runaway: never sync stray
# clones of the vault into itself, and never sync any nested .git repo.
excludes = ["Path vault-*", "Name .git"]

[plugins.ynab-api.personal]
enabled = true
retention_days = 365
`;

function withTempConfig(contents, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-preserve-'));
  const file = path.join(dir, 'today.toml');
  fs.writeFileSync(file, contents);
  try {
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('saving an unchanged config', () => {
  // The regression: saving with nothing changed rewrote the whole file,
  // deleting comments and reordering sections.
  it('leaves the file byte-identical', () => {
    withTempConfig(SAMPLE, file => {
      const { config, raw } = readConfigToml(file);
      writeConfigToml(file, config, raw);
      expect(fs.readFileSync(file, 'utf8')).toBe(SAMPLE);
    });
  });

  it('keeps the warning comment that a rewrite deleted', () => {
    withTempConfig(SAMPLE, file => {
      const { config, raw } = readConfigToml(file);
      writeConfigToml(file, config, raw);
      expect(fs.readFileSync(file, 'utf8')).toContain('nested-clone runaway');
    });
  });
});

describe('saving a changed value', () => {
  it('edits an existing root scalar without rewriting the file', () => {
    withTempConfig(SAMPLE, file => {
      const { config, raw } = readConfigToml(file);
      config.timezone = 'America/Los_Angeles';
      writeConfigToml(file, config, raw);

      const after = fs.readFileSync(file, 'utf8');
      expect(after).toContain('timezone = "America/Los_Angeles"');
      expect(after).toContain('nested-clone runaway');
      expect(after.indexOf('[deployments.local.mini.unison]'))
        .toBeLessThan(after.indexOf('[plugins.ynab-api.personal]'));
      const changed = SAMPLE.split('\n').filter((l, i) => l !== after.split('\n')[i]);
      expect(changed).toEqual(['timezone = "America/New_York"']);
    });
  });

  it('changes only that line and keeps everything else', () => {
    withTempConfig(SAMPLE, file => {
      const { config, raw } = readConfigToml(file);
      config.plugins['imap-email'].icloud.days_to_sync = 60;
      writeConfigToml(file, config, raw);

      const after = fs.readFileSync(file, 'utf8');
      expect(after).toContain('days_to_sync = 60');
      expect(after).toContain('nested-clone runaway');
      // Section order preserved.
      expect(after.indexOf('[deployments.local.mini.unison]'))
        .toBeLessThan(after.indexOf('[plugins.ynab-api.personal]'));
      // Only one line differs.
      const changed = SAMPLE.split('\n').filter((l, i) => l !== after.split('\n')[i]);
      expect(changed).toEqual(['days_to_sync = 30']);
    });
  });

  it('disabling a plugin does not disturb its other settings', () => {
    withTempConfig(SAMPLE, file => {
      const { config, raw } = readConfigToml(file);
      config.plugins['ynab-api'].personal.enabled = false;
      writeConfigToml(file, config, raw);

      const after = parseToml(fs.readFileSync(file, 'utf8'));
      expect(after.plugins['ynab-api'].personal.enabled).toBe(false);
      expect(after.plugins['ynab-api'].personal.retention_days).toBe(365);
    });
  });
});

describe('setTomlValue', () => {
  it('adds a missing key inside its own table, not the next one', () => {
    const out = setTomlValue(SAMPLE, 'plugins.imap-email.icloud', 'include_body', true);
    const lines = out.split('\n');
    const added = lines.findIndex(l => l.startsWith('include_body'));
    const nextTable = lines.findIndex(l => l.startsWith('[deployments'));
    expect(added).toBeGreaterThan(-1);
    expect(added).toBeLessThan(nextTable);
  });

  it('preserves a trailing comment on the line it changes', () => {
    const withComment = 'timezone = "X"\n\n[a]\nk = 1 # keep me\n';
    expect(setTomlValue(withComment, 'a', 'k', 2)).toContain('k = 2 # keep me');
  });

  it('does not match keys inside multiline strings', () => {
    const withMultiline = `[a]
ai_instructions = """
k = 99
"""
k = 1
`;
    expect(setTomlValue(withMultiline, 'a', 'k', 2)).toContain('"""\nk = 2\n');
  });

  it('returns null for a table that is not there', () => {
    expect(setTomlValue(SAMPLE, 'plugins.nope.default', 'enabled', true)).toBeNull();
  });
});

describe('removeTomlTable', () => {
  it('removes the table and the comment block above it', () => {
    const out = removeTomlTable(SAMPLE, 'deployments.local.mini.unison');
    expect(out).not.toContain('nested-clone runaway');
    expect(out).not.toContain('[deployments.local.mini.unison]');
    expect(out).toContain('[plugins.ynab-api.personal]');
  });

  it('returns null when the table is absent', () => {
    expect(removeTomlTable(SAMPLE, 'not.here')).toBeNull();
  });
});

describe('findTableRanges', () => {
  it('finds every table in order', () => {
    const paths = [...findTableRanges(SAMPLE.split('\n')).keys()];
    expect(paths).toEqual([
      'plugins.imap-email.icloud',
      'deployments.local.mini.unison',
      'plugins.ynab-api.personal'
    ]);
  });

  it('ignores table-shaped lines inside multiline strings', () => {
    const withMultiline = `title = "x"

[plugins.alpha.default]
ai_instructions = """
[plugins.fake.default]
not_a_key = true
"""
enabled = true

[plugins.beta.default]
enabled = true
`;

    const paths = [...findTableRanges(withMultiline.split('\n')).keys()];
    expect(paths).toEqual([
      'plugins.alpha.default',
      'plugins.beta.default'
    ]);
  });
});

describe('diffScalarChanges', () => {
  const base = { plugins: { a: { one: { enabled: true, n: 1 } } } };

  it('reports nothing when nothing changed', () => {
    expect(diffScalarChanges(base, structuredClone(base))).toEqual([]);
  });

  it('reports the changed scalar with its table path', () => {
    const next = structuredClone(base);
    next.plugins.a.one.n = 2;
    expect(diffScalarChanges(base, next)).toEqual([
      { table: 'plugins.a.one', key: 'n', value: 2 }
    ]);
  });

  it('reports an existing changed root scalar without flagging structural change', () => {
    expect(diffScalarChanges({ timezone: 'A' }, { timezone: 'B' })).toEqual([
      { table: '', key: 'timezone', value: 'B' }
    ]);
  });

  it('treats unchanged arrays of inline tables as unchanged', () => {
    const before = {
      plugins: {
        a: {
          one: {
            windows: [{ start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' }]
          }
        }
      }
    };
    const after = structuredClone(before);
    expect(diffScalarChanges(before, after)).toEqual([]);
  });

  // A new or deleted table cannot be expressed as a line edit, so the caller
  // must fall back rather than produce a wrong file.
  it('flags an added table as structural', () => {
    const next = structuredClone(base);
    next.plugins.b = { one: { enabled: true } };
    expect(diffScalarChanges(base, next)).toEqual([{ structural: true }]);
  });

  it('flags a removed table as structural', () => {
    expect(diffScalarChanges(base, { plugins: {} })).toEqual([{ structural: true }]);
  });

  it('refuses to apply a structural change', () => {
    expect(applyScalarChanges('anything', [{ structural: true }])).toBeNull();
  });
});
