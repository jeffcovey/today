import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Readers that write as they read must write nothing with READ_ONLY=true (an
// MCP server's pre-read sync), and still write as before without it.

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const TZ = 'America/New_York';

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-readers-'));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, 'config.toml'), `timezone = "${TZ}"\n`);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Every file under root (but config.toml), relative path to content. */
function snapshot(root) {
  const out = {};
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        out[path.relative(root, full) + '/'] = '';
        walk(full);
      } else if (name !== 'config.toml') {
        out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(root);
  return out;
}

function runReader(plugin, root, { config = {}, readOnly = false, env = {} } = {}) {
  const childEnv = {
    ...process.env,
    PROJECT_ROOT: root,
    VAULT_PATH: 'vault',
    CONFIG_PATH: path.join(root, 'config.toml'),
    PLUGIN_CONFIG: JSON.stringify(config),
    TZ,
    LAST_SYNC_TIME: '',
    ...env,
  };
  delete childEnv.READ_ONLY;
  delete childEnv.FILE_FILTER;
  delete childEnv.CONTEXT_ONLY;
  if (readOnly) childEnv.READ_ONLY = 'true';
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'plugins', plugin, 'read.js')], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
  });
  let output = null;
  try { output = JSON.parse(result.stdout.trim().split('\n').pop()); } catch { /* not JSON */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output };
}

function localDate(offsetDays = 0) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('markdown-routines', () => {
  const routine = () => `---
name: Morning
recurrence: daily
history: []
---

- [x] Stretch ⏳ ${localDate(-1)}
- [x] Water ⏳ ${localDate(-1)}
`;

  test('READ_ONLY reports the routine as it stands and leaves the file alone', () => {
    const root = tempRoot();
    write(root, 'vault/routines/morning.md', routine());
    const before = snapshot(root);

    const { status, output } = runReader('markdown-routines', root, { readOnly: true });
    expect(status).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const today = output.entries.find(e => e.date === localDate(0));
    expect(today.status).toBe('completed');
    expect(output.metadata.processed[0].modified).toBe(false);
  });

  test('without READ_ONLY, an overdue routine is reset and written back', () => {
    const root = tempRoot();
    write(root, 'vault/routines/morning.md', routine());

    const { status, output } = runReader('markdown-routines', root);
    expect(status).toBe(0);
    const content = fs.readFileSync(path.join(root, 'vault/routines/morning.md'), 'utf8');
    expect(content).toContain(`- [ ] Stretch ⏳ ${localDate(0)}`);
    expect(content).toContain(`date: ${localDate(-1)}`);
    expect(output.entries.find(e => e.date === localDate(0)).status).toBe('pending');
  });

  test('READ_ONLY creates no routines directory or sample routine', () => {
    const root = tempRoot();
    const { status, output } = runReader('markdown-routines', root, { readOnly: true });
    expect(status).toBe(0);
    expect(output.entries).toEqual([]);
    expect(snapshot(root)).toEqual({});

    expect(runReader('markdown-routines', root).status).toBe(0);
    expect(fs.existsSync(path.join(root, 'vault/routines/morning.md'))).toBe(true);
  });
});

describe('markdown-diary', () => {
  function setup() {
    const root = tempRoot();
    // Only the template: a past day's empty file is removed by a full read.
    write(root, 'vault/diary/2020-01-01.md', '---\ndate: 2020-01-01\n---\n\n');
    // A TODAY section on a past day is stripped by a full read.
    write(root, 'vault/diary/2020-01-02.md', '---\ndate: 2020-01-02\n---\n\n<!-- TODAY:STAGE_NOTICE:START -->\nnotice\n<!-- TODAY:STAGE_NOTICE:END -->\n\n## Notes\n\n- 09:00 Walked the dog\n');
    return root;
  }

  test('READ_ONLY reads the diary as it stands and writes nothing', () => {
    const root = setup();
    const before = snapshot(root);
    const { status, output } = runReader('markdown-diary', root, { readOnly: true });
    expect(status).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(output.metadata.created_today).toBeUndefined();
    expect(output.metadata.diary_files).toBe(2);
  });

  test('without READ_ONLY, past days are cleaned up and today\'s file is created', () => {
    const root = setup();
    const { status, output } = runReader('markdown-diary', root);
    expect(status).toBe(0);
    expect(fs.existsSync(path.join(root, 'vault/diary/2020-01-01.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'vault/diary/2020-01-02.md'), 'utf8')).not.toContain('TODAY:');
    expect(fs.existsSync(path.join(root, `vault/diary/${localDate(0)}.md`))).toBe(true);
    expect(output.metadata.created_today).toBe(`${localDate(0)}.md`);
  });

  test('READ_ONLY creates no diary directory', () => {
    const root = tempRoot();
    expect(runReader('markdown-diary', root, { readOnly: true }).status).toBe(0);
    expect(snapshot(root)).toEqual({});
  });
});

describe('streaks-habits', () => {
  function setup() {
    const root = tempRoot();
    const data = JSON.stringify({ tasks: [], categories: [] });
    write(root, 'vault/logs/iPhone - 20260101T090000.streaks', data);
    write(root, 'vault/logs/iPhone - 20260102T090000.streaks', data);
    return root;
  }
  const config = { cleanup_old_files: true };

  test('READ_ONLY leaves older exports in place', () => {
    const root = setup();
    const before = snapshot(root);
    expect(runReader('streaks-habits', root, { config, readOnly: true }).status).toBe(0);
    expect(snapshot(root)).toEqual(before);
  });

  test('without READ_ONLY, older exports are deleted', () => {
    const root = setup();
    expect(runReader('streaks-habits', root, { config }).status).toBe(0);
    expect(fs.readdirSync(path.join(root, 'vault/logs'))).toEqual(['iPhone - 20260102T090000.streaks']);
  });
});

describe('project-calendar', () => {
  async function setup() {
    const root = tempRoot();
    const Database = (await import('better-sqlite3')).default;
    fs.mkdirSync(path.join(root, '.data'));
    const db = new Database(path.join(root, '.data', 'today.db'));
    db.exec('CREATE TABLE projects (id TEXT, title TEXT, start_date TEXT, due_date TEXT, url TEXT, status TEXT)');
    db.prepare("INSERT INTO projects VALUES ('p1', 'Launch', NULL, '2026-12-01', NULL, 'active')").run();
    db.close();
    write(root, '.data/project-calendar-work.json', JSON.stringify({ p1: 'event-1' }));
    // Stands in for bin/calendar: records that sync-projects was run.
    write(root, 'bin/calendar', `const fs = require('fs');\nfs.appendFileSync(${JSON.stringify(path.join(root, 'calendar.log'))}, process.argv.slice(2).join(' ') + '\\n');\n`);
    return root;
  }
  const config = { calendar_source: 'work' };

  test('READ_ONLY reports the synced projects without pushing to the calendar', async () => {
    const root = await setup();
    const { status, output } = runReader('project-calendar', root, { config, readOnly: true });
    expect(status).toBe(0);
    expect(fs.existsSync(path.join(root, 'calendar.log'))).toBe(false);
    expect(output.entries.map(e => e.title)).toEqual(['Launch']);
  });

  test('without READ_ONLY, it runs bin/calendar sync-projects first', async () => {
    const root = await setup();
    const { status, output } = runReader('project-calendar', root, { config });
    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(root, 'calendar.log'), 'utf8')).toBe('sync-projects work\n');
    expect(output.entries.map(e => e.title)).toEqual(['Launch']);
  });
});

describe('github-projects', () => {
  // A stand-in gh on PATH: logs each call, answers the projects query with
  // one project that has no Priority field, and anything else with no data.
  function setup() {
    const root = tempRoot();
    const binDir = path.join(root, 'fakebin');
    const log = path.join(root, 'gh.log');
    const project = {
      id: 'P1', title: 'Proj', number: 1, url: 'https://github.com/users/me/projects/1',
      closed: false, updatedAt: new Date().toISOString(), fields: { nodes: [{ name: 'Status' }] },
    };
    write(root, 'fakebin/gh', `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, (args.includes('mutation') ? 'mutation' : 'call') + '\\n');
if (args.includes('projectsV2(') && !args.includes('mutation')) {
  console.log(JSON.stringify({ data: { user: { projectsV2: { nodes: [${JSON.stringify(project)}] } } } }));
} else {
  console.log(JSON.stringify({ data: {} }));
}
`);
    fs.chmodSync(path.join(binDir, 'gh'), 0o755);
    // CommonJS, whatever the repo's package type.
    write(root, 'fakebin/package.json', '{"type":"commonjs"}');
    return { root, env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` }, log };
  }
  const config = { owner: 'me', type: 'user', create_priority_field: true };
  const mutations = log => fs.readFileSync(log, 'utf8').split('\n').filter(l => l === 'mutation').length;

  test('READ_ONLY adds no fields to the project', () => {
    const { root, env, log } = setup();
    const { status, output } = runReader('github-projects', root, { config, env, readOnly: true });
    expect(status).toBe(0);
    expect(output.entries.length).toBe(1);
    expect(mutations(log)).toBe(0);
  });

  test('without READ_ONLY, a missing Priority field is created', () => {
    const { root, env, log } = setup();
    const { status } = runReader('github-projects', root, { config, env });
    expect(status).toBe(0);
    expect(mutations(log)).toBe(1);
  });
});

describe('trusted-housesitters', () => {
  test('READ_ONLY reports cached listings without scraping or writing', () => {
    const root = tempRoot();
    const listing = {
      id: 'l1', title: 'Sit in Lisbon', url: 'https://example.invalid/l1', date_added: '2026-10-01',
      start_date: '2026-12-01', end_date: '2026-12-10', duration_days: 9,
      city: 'Lisbon', state: null, country: 'Portugal', animals: [],
    };
    write(root, '.data/trusted-housesitters/listings.json', JSON.stringify([listing]));
    const before = snapshot(root);
    const { status, output, stderr } = runReader('trusted-housesitters', root, { readOnly: true });
    expect(status).toBe(0);
    expect(stderr).toContain('READ_ONLY mode - reading from cache');
    expect(output.entries.map(e => e.id)).toEqual(['l1']);
    expect(snapshot(root)).toEqual(before);
  });
});
