/**
 * The "medium" MCP write tools from issue #686: add_diary_entry,
 * restart_timer, add_time_entry, reply_to_role, update_event, delete_event
 * and categorize_transaction.
 *
 * Handlers are called directly. Writes to outside services (the calendar
 * plugin, YNAB) and plugin syncs are replaced through ctx, so nothing here
 * reaches Google or YNAB.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { clearConfigCache } from '../src/config.js';
import { getSqlColumns, getTableName } from '../src/plugin-schemas.js';
import { setRegisteredToolsForTesting, getRegisteredTools } from '../src/mcp-tools/index.js';
import { spawnSync } from 'child_process';
import { insertDiaryEntry, addDiaryEntry, resolveDiaryDirectory } from '../src/diary-add.js';
import { parseCallerTime, formatInZone } from '../src/mcp-tools/_time.js';
import { tools as diaryTools } from '../src/mcp-tools/diary-writes.js';
import { tools as timerTools } from '../src/mcp-tools/timer-writes.js';
import { tools as roleTools } from '../src/mcp-tools/role-replies.js';
import { tools as calendarTools, runEventPluginWrite } from '../src/mcp-tools/calendar-writes.js';
import { tools as financeTools } from '../src/mcp-tools/finance-writes.js';
import { todayPlanRelativePath } from '../plugins/roles/plan-file.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 'America/New_York';
// Noon in New York on 2026-11-01 (EST, -05:00: DST ended at 2 AM that day).
const NOW = new Date('2026-11-01T17:00:00Z');

const byName = Object.fromEntries(
  [...diaryTools, ...timerTools, ...roleTools, ...calendarTools, ...financeTools].map(t => [t.name, t])
);
const call = (name, args, ctx) => byName[name].handler(args, ctx);
const text = result => result.content.map(c => c.text).join('\n');
const json = result => JSON.parse(result.content[result.content.length - 1].text);

function tableDb(...types) {
  const db = new Database(':memory:');
  for (const type of types) db.exec(`CREATE TABLE ${getTableName(type)} (${getSqlColumns(type)})`);
  return db;
}

function recorder(reply = () => ({ success: true })) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return reply(...args); };
  fn.calls = calls;
  return fn;
}

let workDir;
let vaultDir;
let diaryDir;
const saved = {};

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-mcp-medium-'));
  vaultDir = path.join(workDir, 'vault');
  diaryDir = path.join(workDir, 'diary');
  await fs.mkdir(vaultDir, { recursive: true });
  for (const key of ['TODAY_CONFIG', 'VAULT_PATH', 'TZ']) saved[key] = process.env[key];
  delete process.env.VAULT_PATH;
  process.env.TZ = TZ;
  process.env.TODAY_CONFIG = path.join(workDir, 'config.toml');
  // getAbsoluteVaultPath() joins vault_path onto the project root, so give it a relative path.
  await fs.writeFile(process.env.TODAY_CONFIG, [
    `timezone = "${TZ}"`,
    `vault_path = "${path.relative(PROJECT_ROOT, vaultDir)}"`,
    '[mcp]', 'write_log = false',
    // The diary reader joins diary_directory onto the project root, so the writer does too.
    '[plugins.markdown-diary.default]', 'enabled = true', `diary_directory = "${path.relative(PROJECT_ROOT, diaryDir)}"`,
    '[plugins.roles.default]', 'enabled = true',
    '[plugins.google-calendar.personal]', 'enabled = true', 'calendar_id = "me@example.com"',
    '[plugins.public-calendars.holidays]', 'enabled = true', 'url = "https://example.com/holidays.ics"',
    '',
  ].join('\n'));
  clearConfigCache();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearConfigCache();
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('registry', () => {
  test('loads every module with its kind and plugin type', async () => {
    setRegisteredToolsForTesting(null);
    const tools = await getRegisteredTools();
    const got = Object.fromEntries(
      ['add_diary_entry', 'restart_timer', 'add_time_entry', 'reply_to_role', 'update_event', 'delete_event', 'categorize_transaction']
        .map(name => [name, tools.get(name) && [tools.get(name).kind, tools.get(name).pluginType]])
    );
    expect(got).toEqual({
      add_diary_entry: ['write', 'diary'],
      restart_timer: ['write', 'time-logs'],
      add_time_entry: ['write', 'time-logs'],
      reply_to_role: ['write', 'utility'],
      update_event: ['destructive', 'events'],
      delete_event: ['destructive', 'events'],
      categorize_transaction: ['destructive', 'finance'],
    });
  });
});

describe('caller times', () => {
  test('naive times are read in the given zone, not the host\'s', () => {
    expect(formatInZone(parseCallerTime('2026-11-03T10:00', TZ).date, TZ)).toBe('2026-11-03T10:00:00-05:00');
    expect(formatInZone(parseCallerTime('2026-07-03 10:00', TZ).date, TZ)).toBe('2026-07-03T10:00:00-04:00');
    expect(formatInZone(parseCallerTime('2026-11-03T10:00', 'America/Los_Angeles').date, TZ)).toBe('2026-11-03T13:00:00-05:00');
    expect(formatInZone(parseCallerTime('2026-11-03T15:00:00Z', TZ).date, TZ)).toBe('2026-11-03T10:00:00-05:00');
  });

  test('bad times are refused', () => {
    expect(parseCallerTime('2026-02-30T10:00', TZ).error).toMatch(/not a valid/);
    expect(parseCallerTime('tomorrow', TZ).error).toMatch(/Could not read/);
    expect(parseCallerTime('9:00', TZ).error).toMatch(/Could not read/);
    expect(parseCallerTime('9:00', TZ, { allowTimeOnly: true }).date).toBeInstanceOf(Date);
  });

  test('HH:MM is read on the reference day, not the host clock\'s', () => {
    const now = new Date('2026-03-10T03:30:00Z'); // 23:30 on March 9 in New York
    expect(formatInZone(parseCallerTime('9:00', TZ, { allowTimeOnly: true, now }).date, TZ)).toBe('2026-03-09T09:00:00-04:00');
    expect(formatInZone(parseCallerTime('9:00', 'UTC', { allowTimeOnly: true, now }).date, TZ)).toBe('2026-03-10T05:00:00-04:00');
  });
});

describe('add_diary_entry', () => {
  test('insertDiaryEntry adds sections the way bin/diary does, outside role blocks', () => {
    const fresh = insertDiaryEntry(null, { type: 'progress', text: 'Shipped it', date: '2026-11-01', time: '12:00' });
    expect(fresh.content).toBe('---\ndate: 2026-11-01\n---\n\n## Progress\n\n### 12:00\nShipped it\n');

    const existing = [
      '---', 'date: 2026-11-01', '---', '',
      "## I'm grateful for...", '- coffee', '',
      '## Concerns', '', '### 08:00', 'Rain', '',
      '<!-- ROLE:cpa:START -->', '## 🤖 CPA', '', '### 09:00', 'Report', '<!-- ROLE:cpa:END -->', '',
    ].join('\n');
    const grateful = insertDiaryEntry(existing, { type: 'gratitude', text: 'friends', date: '2026-11-01', time: '12:00' });
    expect(grateful.content).toContain("## I'm grateful for...\n- coffee\n- friends\n\n## Concerns");

    const concern = insertDiaryEntry(existing, { type: 'concern', text: 'Wind', date: '2026-11-01', time: '12:00' });
    expect(concern.content).toContain('### 08:00\nRain\n\n### 12:00\nWind\n\n<!-- ROLE:cpa:START -->');
    expect(concern.content.match(/## Concern/g)).toHaveLength(1);
    expect(concern.content).toContain('<!-- ROLE:cpa:START -->\n## 🤖 CPA\n\n### 09:00\nReport\n<!-- ROLE:cpa:END -->');
  });

  test('untimed text already in a section is kept under a midnight heading the reader reads', async () => {
    const existing = ['---', 'date: 2026-11-01', '---', '', '## Journal', 'Slept badly.', '', '## Progress', '', '### 08:00', 'Early', ''].join('\n');
    const journal = insertDiaryEntry(existing, { type: 'journal', text: 'Better now', date: '2026-11-01', time: '12:00' });
    expect(journal.content).toContain('## Journal\n\n### 00:00\nSlept badly.\n\n### 12:00\nBetter now\n\n## Progress');
    const progress = insertDiaryEntry(existing, { type: 'progress', text: 'Later', date: '2026-11-01', time: '12:00' });
    expect(progress.content).toContain('## Progress\n\n### 08:00\nEarly\n\n### 12:00\nLater\n');
    expect(progress.content).not.toContain('### 00:00');

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'today-diary-untimed-'));
    try {
      const dir = path.join(root, 'vault', 'diary');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '2026-10-20.md'), ['---', 'date: 2026-10-20', '---', '', '## Journal', 'Slept badly.', ''].join('\n'));
      addDiaryEntry({ type: 'journal', text: 'Better now', diaryDir: dir, timezone: TZ, now: new Date('2026-10-20T16:00:00Z') });
      const result = spawnSync('node', [path.join(PROJECT_ROOT, 'plugins', 'markdown-diary', 'read.js')], {
        encoding: 'utf8',
        env: {
          ...process.env, TZ, PROJECT_ROOT: root, VAULT_PATH: path.join(root, 'vault'), SOURCE_ID: 'markdown-diary/test',
          LAST_SYNC_TIME: '', CONFIG_PATH: path.join(root, 'config.toml'), PLUGIN_CONFIG: JSON.stringify({ diary_directory: 'vault/diary' }),
        },
      });
      const rows = JSON.stringify(JSON.parse(result.stdout.trim().split('\n').pop()));
      expect(rows).toContain('Slept badly.');
      expect(rows).toContain('Better now');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('headings inside ROLE and TODAY blocks are not the user\'s sections', () => {
    const roleBlock = ['<!-- ROLE:coach:START -->', '## Progress', '', '### 09:00', 'Role report', '<!-- ROLE:coach:END -->'];
    const onlyInBlock = ['---', 'date: 2026-11-01', '---', '', ...roleBlock, ''].join('\n');
    const added = insertDiaryEntry(onlyInBlock, { type: 'progress', text: 'Mine', date: '2026-11-01', time: '12:00' });
    expect(added.content).toBe(`${onlyInBlock.trimEnd()}\n\n## Progress\n\n### 12:00\nMine\n`);

    const both = ['---', 'date: 2026-11-01', '---', '',
      '<!-- TODAY:plan:START -->', '## Journal', 'generated', '<!-- TODAY:plan:END -->', '',
      ...roleBlock, '', '## Progress', '', '### 08:00', 'Earlier', '', '## Journal', ''].join('\n');
    const progress = insertDiaryEntry(both, { type: 'progress', text: 'Mine', date: '2026-11-01', time: '12:00' });
    expect(progress.content).toContain('### 08:00\nEarlier\n\n### 12:00\nMine\n\n## Journal');
    expect(progress.content).toContain(roleBlock.join('\n'));
    const journal = insertDiaryEntry(both, { type: 'journal', text: 'Mine', date: '2026-11-01', time: '12:00' });
    expect(journal.content).toContain('<!-- TODAY:plan:START -->\n## Journal\ngenerated\n<!-- TODAY:plan:END -->');
    expect(journal.content.endsWith('## Journal\n\n### 12:00\nMine\n')).toBe(true);
  });

  test('an absolute diary_directory is resolved the way the diary reader resolves it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'today-diary-root-'));
    try {
      const configured = '/abs/diary';
      const dir = resolveDiaryDirectory({ diary_directory: configured }, root);
      expect(dir).toBe(path.join(root, 'abs', 'diary'));
      addDiaryEntry({ type: 'journal', text: 'Read me back', diaryDir: dir, timezone: TZ, now: new Date('2026-10-20T16:00:00Z') });

      const result = spawnSync('node', [path.join(PROJECT_ROOT, 'plugins', 'markdown-diary', 'read.js')], {
        encoding: 'utf8',
        env: {
          ...process.env, TZ, PROJECT_ROOT: root, VAULT_PATH: path.join(root, 'vault'), SOURCE_ID: 'markdown-diary/test',
          LAST_SYNC_TIME: '', CONFIG_PATH: path.join(root, 'config.toml'), PLUGIN_CONFIG: JSON.stringify({ diary_directory: configured }),
        },
      });
      const out = JSON.parse(result.stdout.trim().split('\n').pop());
      const rows = out.entries || out.rows || out.items || out;
      expect(JSON.stringify(rows)).toContain('Read me back');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('waits for the day\'s file lock and refuses, changing nothing, while another write holds it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-diary-lock-'));
    try {
      const now = new Date('2026-10-20T16:00:00Z');
      const first = addDiaryEntry({ type: 'journal', text: 'First', diaryDir: dir, timezone: TZ, now });
      expect(await fs.readdir(dir)).toEqual(['2026-10-20.md']); // the lock is released
      const before = await fs.readFile(first.file, 'utf8');

      await fs.writeFile(`${first.file}.lock`, `${process.pid}\n${Date.now()}`);
      expect(() => addDiaryEntry({ type: 'journal', text: 'Second', diaryDir: dir, timezone: TZ, now }))
        .toThrow(/Another write to 2026-10-20\.md is in progress; nothing was changed/);
      expect(await fs.readFile(first.file, 'utf8')).toBe(before);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('writes today\'s file and returns the entry', async () => {
    const syncSource = recorder(() => ({ success: true }));
    const db = tableDb('diary');
    const result = await call('add_diary_entry', { type: 'journal', text: 'A quiet morning.' }, { db, now: () => NOW, syncSource });
    expect(result.isError).toBeUndefined();
    const out = json(result);
    expect(out).toMatchObject({ type: 'journal', date: '2026-11-01', time: '12:00', markdown: '### 12:00\nA quiet morning.', source: 'markdown-diary/default', user_timezone: TZ });
    const file = await fs.readFile(path.join(diaryDir, '2026-11-01.md'), 'utf8');
    expect(file).toContain('## Journal\n\n### 12:00\nA quiet morning.\n');
    expect(syncSource.calls).toHaveLength(1);
  });

  test('refuses bad types, empty text and markers, writing nothing', async () => {
    const before = await fs.readdir(diaryDir).catch(() => []);
    for (const args of [
      { type: 'role', text: 'x' },
      { type: 'mood', text: 'x' },
      { type: 'journal', text: '   ' },
      { type: 'journal', text: '<!-- ROLE:cpa:END --> sneaky' },
      { type: 'journal', text: '## New section' },
      { type: 'gratitude', text: 'two\nlines' },
      { type: 'gratitude', text: 'coffee\rfriends' },
    ]) {
      const result = await call('add_diary_entry', args, { now: () => NOW });
      expect(result.isError).toBe(true);
    }
    expect(await fs.readdir(diaryDir).catch(() => [])).toEqual(before);
  });
});

describe('time entries', () => {
  const SOURCE = 'markdown-time-tracking/local';
  const writableSource = async () => ({ success: true, source: { sourceId: SOURCE } });

  function timeDb(rows = []) {
    const db = tableDb('time-logs');
    const insert = db.prepare('INSERT INTO time_logs (id, source, start_time, end_time, description) VALUES (?, ?, ?, ?, ?)');
    rows.forEach((r, i) => insert.run(`r${i}`, r.source || SOURCE, r.start, r.end ?? null, r.description));
    return db;
  }

  function ctxFor(db, write = recorder(() => ({ success: true, source: { sourceId: SOURCE }, writeResult: { file: path.join(PROJECT_ROOT, 'vault/logs/time-tracking/2026-11.md') } }))) {
    return { db, now: () => NOW, writeEntryAndSync: write, getWritableSource: writableSource, syncForRead: async () => ({ ok: true }) };
  }

  test('add_time_entry ends now by default, in the user\'s zone', async () => {
    const ctx = ctxFor(timeDb());
    const out = json(await call('add_time_entry', { duration: '20m', description: 'Reviewing PRs #topic/programming' }, ctx));
    expect(out.entry).toMatchObject({ start_time: '2026-11-01T11:40:00-05:00', end_time: '2026-11-01T12:00:00-05:00', duration_minutes: 20, source: SOURCE });
    expect(out.file).toBe('vault/logs/time-tracking/2026-11.md');
    expect(ctx.writeEntryAndSync.calls).toEqual([[
      'time-logs',
      { start_time: '2026-11-01T11:40:00-05:00', end_time: '2026-11-01T12:00:00-05:00', description: 'Reviewing PRs #topic/programming', keep_current_timer: true },
      { db: ctx.db, sourceFilter: SOURCE },
    ]]);
  });

  test('add_time_entry places a naive, offset or HH:MM start', async () => {
    for (const [start, expected] of [
      ['2026-11-01T09:00', '2026-11-01T09:00:00-05:00'],
      ['2026-11-01T14:00:00Z', '2026-11-01T09:00:00-05:00'],
      ['9:00', '2026-11-01T09:00:00-05:00'],
    ]) {
      const ctx = ctxFor(timeDb());
      const out = json(await call('add_time_entry', { duration: '1h30m', description: 'Spanish #topic/languages', start }, ctx));
      expect(out.entry.start_time).toBe(expected);
      expect(out.entry.end_time).toBe('2026-11-01T10:30:00-05:00');
    }
  });

  test('add_time_entry refuses bad durations, future ends and broken descriptions', async () => {
    for (const args of [
      { duration: '25h', description: 'Marathon' },
      { duration: 'a while', description: 'Something' },
      { duration: '-1h30m', description: 'Negative' },
      { duration: '1.5h30m', description: 'Compound decimal' },
      { duration: '1h30m15s', description: 'Trailing seconds' },
      { duration: '20m', description: 'Later', start: '2026-11-01T11:50' },
      { duration: '20m', description: 'a | b' },
      { duration: '20m', description: 'two\nlines' },
      { duration: '20m', description: '' },
    ]) {
      const ctx = ctxFor(timeDb());
      const result = await call('add_time_entry', args, ctx);
      expect(result.isError).toBe(true);
      expect(ctx.writeEntryAndSync.calls).toHaveLength(0);
    }
  });

  test('add_time_entry takes each whole duration form parseDuration documents', async () => {
    for (const [duration, minutes] of [['20m', 20], ['35 minutes', 35], ['5min', 5], ['2h', 120], ['2 hours', 120],
      ['1.5h', 90], ['0.5hours', 30], ['2h30m', 150], ['1H 30M', 90], ['1hours30minutes', 90]]) {
      const out = json(await call('add_time_entry', { duration, description: 'Work' }, ctxFor(timeDb())));
      expect([duration, out.entry.duration_minutes]).toEqual([duration, minutes]);
    }
  });

  test('add_time_entry keeps a timer running on the same source', async () => {
    const ctx = ctxFor(timeDb([{ start: '2026-11-01T11:30:00-05:00', description: 'Writing #topic/writing' }]));
    const out = json(await call('add_time_entry', { duration: '15m', description: 'Call with Sam', start: '10:00' }, ctx));
    expect(out.running_timer).toMatch(/left running/);
    // One write that tells the plugin to leave current-timer.md alone; nothing is cleared and written back.
    expect(ctx.writeEntryAndSync.calls.map(c => c[1])).toEqual([
      { start_time: '2026-11-01T10:00:00-05:00', end_time: '2026-11-01T10:15:00-05:00', description: 'Call with Sam', keep_current_timer: true },
    ]);
  });

  test('add_time_entry reads HH:MM on the handler\'s own day', async () => {
    const ctx = { ...ctxFor(timeDb()), now: () => new Date('2026-03-12T16:00:00Z') };
    const out = json(await call('add_time_entry', { duration: '30m', description: 'Standup', start: '9:00' }, ctx));
    expect(out.entry.start_time).toBe('2026-03-12T09:00:00-04:00');
    const late = await call('add_time_entry', { duration: '30m', description: 'Standup', start: '13:00' }, ctx);
    expect(late.isError).toBe(true);
    expect(text(late)).toMatch(/in the future/);
  });

  test('a saved entry whose cache sync failed is reported as saved, not as an error', async () => {
    const partial = recorder(() => ({
      success: false, partialSuccess: true, error: 'Write succeeded, but local sync failed: disk busy',
      source: { sourceId: SOURCE }, writeResult: { file: path.join(PROJECT_ROOT, 'vault/logs/time-tracking/2026-11.md') },
    }));
    const added = await call('add_time_entry', { duration: '20m', description: 'Email' }, ctxFor(timeDb(), partial));
    expect(added.isError).toBeUndefined();
    expect(json(added)).toMatchObject({ saved: true, file: 'vault/logs/time-tracking/2026-11.md' });
    expect(json(added).note).toMatch(/local sync failed: disk busy.*don't repeat this call/);

    const restarted = await call('restart_timer', {}, ctxFor(timeDb([
      { start: '2026-11-01T08:00:00-05:00', end: '2026-11-01T09:00:00-05:00', description: 'Email' },
    ]), partial));
    expect(restarted.isError).toBeUndefined();
    expect(json(restarted).saved).toBe(true);

    const failed = recorder(() => ({ success: false, error: 'Failed to write: EACCES' }));
    const refused = await call('add_time_entry', { duration: '20m', description: 'Email' }, ctxFor(timeDb(), failed));
    expect(refused.isError).toBe(true);
  });

  test('the time-tracking plugin leaves current-timer.md alone only when asked', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'today-time-write-'));
    try {
      const timerFile = path.join(root, 'vault/logs/time-tracking/current-timer.md');
      const run = entry => spawnSync('node', [path.join(PROJECT_ROOT, 'plugins/markdown-time-tracking/write.js')], {
        encoding: 'utf8',
        env: { ...process.env, PROJECT_ROOT: root, VAULT_PATH: 'vault', PLUGIN_CONFIG: '{}', ENTRY_JSON: JSON.stringify(entry) },
      });
      const done = { start_time: '2026-11-01T10:00:00-05:00', end_time: '2026-11-01T10:15:00-05:00', description: 'Call' };
      run({ start_time: '2026-11-01T11:30:00-05:00', end_time: null, description: 'Writing' });

      expect(JSON.parse(run({ ...done, keep_current_timer: true }).stdout).success).toBe(true);
      expect(await fs.readFile(timerFile, 'utf8')).toBe('Writing\n2026-11-01T11:30:00-05:00');

      expect(JSON.parse(run(done).stdout).success).toBe(true);
      expect(await fs.readFile(timerFile, 'utf8')).toBe('');
      const monthFile = path.join(root, 'vault/logs/time-tracking/2026-11.md');
      const month = await fs.readFile(monthFile, 'utf8');
      expect(month.trim().split('\n')).toHaveLength(2);

      // A stop that can't take the timer's lock changes nothing: no entry is
      // appended, so a retry doesn't record the interval twice.
      await fs.writeFile(timerFile, 'Writing\n2026-11-01T11:30:00-05:00');
      await fs.writeFile(`${timerFile}.lock`, `${process.pid}\n${Date.now()}`);
      const locked = run(done);
      expect(JSON.parse(locked.stdout).error).toMatch(/Timed out acquiring file lock/);
      expect(await fs.readFile(monthFile, 'utf8')).toBe(month);
      expect(await fs.readFile(timerFile, 'utf8')).toBe('Writing\n2026-11-01T11:30:00-05:00');

      // keep_current_timer takes no lock, so past work is still recorded.
      expect(JSON.parse(run({ ...done, keep_current_timer: true }).stdout).success).toBe(true);
      expect((await fs.readFile(monthFile, 'utf8')).trim().split('\n')).toHaveLength(3);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('with start_if_idle, the time-tracking plugin refuses to replace a running timer', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'today-time-idle-'));
    try {
      const timerFile = path.join(root, 'vault/logs/time-tracking/current-timer.md');
      const run = entry => spawnSync('node', [path.join(PROJECT_ROOT, 'plugins/markdown-time-tracking/write.js')], {
        encoding: 'utf8',
        env: { ...process.env, PROJECT_ROOT: root, VAULT_PATH: 'vault', PLUGIN_CONFIG: '{}', ENTRY_JSON: JSON.stringify(entry) },
      });
      const restart = { start_time: '2026-11-01T12:00:00-05:00', end_time: null, description: 'Restarted', start_if_idle: true };

      const started = run(restart);
      expect(JSON.parse(started.stdout).success).toBe(true);
      expect(await fs.readFile(timerFile, 'utf8')).toBe('Restarted\n2026-11-01T12:00:00-05:00');

      await fs.writeFile(timerFile, 'Writing\n2026-11-01T11:30:00-05:00');
      const refused = run(restart);
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({ success: false, error: expect.stringMatching(/already running: "Writing".*nothing was changed/) });
      expect(await fs.readFile(timerFile, 'utf8')).toBe('Writing\n2026-11-01T11:30:00-05:00');

      // Without the option a start still replaces the timer, as before.
      expect(JSON.parse(run({ ...restart, start_if_idle: undefined, description: 'Plain' }).stdout).success).toBe(true);
      expect(await fs.readFile(timerFile, 'utf8')).toBe('Plain\n2026-11-01T12:00:00-05:00');

      // The check and the write wait for the shared lock on current-timer.md.
      await fs.writeFile(timerFile, '');
      await fs.writeFile(`${timerFile}.lock`, `${process.pid}\n${Date.now()}`);
      const locked = run(restart);
      expect(JSON.parse(locked.stdout).error).toMatch(/Timed out acquiring file lock/);
      expect(await fs.readFile(timerFile, 'utf8')).toBe('');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('restart_timer reports the plugin\'s refusal when a timer started after the check', async () => {
    const write = recorder(() => ({ success: false, error: 'A timer is already running: "Writing" since 2026-11-01T11:30:00-05:00. Stop it first; nothing was changed.' }));
    const ctx = ctxFor(timeDb([{ start: '2026-11-01T08:00:00-05:00', end: '2026-11-01T09:00:00-05:00', description: 'Email' }]), write);
    const result = await call('restart_timer', {}, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/already running: "Writing".*nothing was changed/);
  });

  test('restart_timer starts the last entry\'s description now', async () => {
    const ctx = ctxFor(timeDb([
      { start: '2026-11-01T08:00:00-05:00', end: '2026-11-01T09:00:00-05:00', description: 'Email' },
      { start: '2026-11-01T09:00:00-05:00', end: '2026-11-01T15:30:00Z', description: 'Deep work #topic/programming' },
    ]));
    const result = await call('restart_timer', {}, ctx);
    const out = json(result);
    expect(out.started).toEqual({ description: 'Deep work #topic/programming', start_time: '2026-11-01T12:00:00-05:00', source: SOURCE });
    expect(out.restarted_from.end_time).toBe('2026-11-01T10:30:00-05:00');
    expect(ctx.writeEntryAndSync.calls).toEqual([[
      'time-logs',
      { start_time: '2026-11-01T12:00:00-05:00', end_time: null, description: 'Deep work #topic/programming', start_if_idle: true },
      { db: ctx.db, sourceFilter: SOURCE },
    ]]);
  });

  test('restart_timer refuses while a timer runs, and with nothing to restart', async () => {
    const running = ctxFor(timeDb([
      { start: '2026-11-01T08:00:00-05:00', end: '2026-11-01T09:00:00-05:00', description: 'Email' },
      { start: '2026-11-01T11:00:00-05:00', description: 'Still going' },
    ]));
    const refused = await call('restart_timer', {}, running);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/already running: "Still going"/);
    expect(running.writeEntryAndSync.calls).toHaveLength(0);

    const empty = ctxFor(timeDb());
    expect((await call('restart_timer', {}, empty)).isError).toBe(true);
    expect(empty.writeEntryAndSync.calls).toHaveLength(0);
  });
});

describe('reply_to_role', () => {
  let planFile;
  const plan = [
    '# Daily Plan', '',
    '<!-- ROLE:cpa:START -->', '## 🤖 CPA', '', '### 09:00', '', 'Three bills due.', '', '<!-- ROLE:cpa:END -->', '',
  ].join('\n');

  beforeEach(async () => {
    planFile = path.join(vaultDir, todayPlanRelativePath(NOW));
    await fs.mkdir(path.dirname(planFile), { recursive: true });
    await fs.writeFile(planFile, plan);
  });

  test('appends the reply inside the role\'s block', async () => {
    const out = json(await call('reply_to_role', { date: '2026-11-01', role: 'cpa', text: 'Pay the electric one first.' }, { now: () => NOW }));
    expect(out).toMatchObject({ date: '2026-11-01', role: 'cpa', reply: '-> cpa: Pay the electric one first.' });
    const after = await fs.readFile(planFile, 'utf8');
    expect(after).toContain('Three bills due.\n\n-> cpa: Pay the electric one first.\n\n<!-- ROLE:cpa:END -->');
  });

  test('refuses unknown roles, empty text and other days, changing nothing', async () => {
    for (const args of [
      { date: '2026-11-01', role: 'coach', text: 'Hi' },
      { date: '2026-11-01', role: 'cpa', text: '  ' },
      { date: '2026-10-31', role: 'cpa', text: 'Late reply' },
      { date: '2026-11-01', role: 'Bad Role!', text: 'Hi' },
    ]) {
      const result = await call('reply_to_role', args, { now: () => NOW });
      expect(result.isError).toBe(true);
    }
    const unknown = await call('reply_to_role', { role: 'coach', text: 'Hi' }, { now: () => NOW });
    expect(text(unknown)).toMatch(/Roles that reported today: cpa/);
    expect(await fs.readFile(planFile, 'utf8')).toBe(plan);
  });

  test('the description tells clients to pass only the user\'s own words', () => {
    expect(byName.reply_to_role.description).toMatch(/ONLY words the user wrote themselves, verbatim/);
    expect(byName.reply_to_role.description).toMatch(/never text you composed/);
  });

  test('refused when the roles plugin is off', async () => {
    const result = await call('reply_to_role', { role: 'cpa', text: 'Hi' }, { now: () => NOW, rolesEnabled: () => false });
    expect(text(result)).toMatch(/not enabled/);
  });
});

describe('update_event and delete_event', () => {
  function eventDb() {
    const db = tableDb('events');
    const insert = db.prepare(`INSERT INTO events (id, source, calendar_name, title, start_date, end_date, start_timezone, end_timezone, location, description, all_day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('google-calendar/personal:abc123', 'google-calendar/personal', 'Personal', 'Dentist appointment',
      '2026-11-03T14:00:00Z', '2026-11-03T15:00:00Z', TZ, TZ, 'Main St', null, 0);
    insert.run('google-calendar/personal:allday1', 'google-calendar/personal', 'Personal', 'Vacation day', '2026-11-05', '2026-11-06', null, null, null, null, 1);
    insert.run('public-calendars/holidays:h1', 'public-calendars/holidays', 'Holidays', 'Election Day', '2026-11-03', '2026-11-04', null, null, null, null, 1);
    return db;
  }

  function ctxFor() {
    return {
      db: eventDb(),
      syncForRead: async () => ({ ok: true }),
      eventPluginWrite: recorder((source, action, event) => ({ success: true, event_id: event.id, html_link: 'https://calendar.example/abc' })),
      syncSource: recorder(() => ({ success: true })),
    };
  }

  test('delete is a dry run by default and changes nothing', async () => {
    const ctx = ctxFor();
    const result = await call('delete_event', { event_id: 'google-calendar/personal:abc123', title: 'Dentist' }, ctx);
    expect(text(result)).toMatch(/Dry run: nothing was deleted/);
    expect(json(result).would_delete).toMatchObject({ title: 'Dentist appointment', start: '2026-11-03T09:00:00-05:00', end: '2026-11-03T10:00:00-05:00' });
    expect(ctx.eventPluginWrite.calls).toHaveLength(0);
  });

  test('delete with dry_run false sends the calendar\'s own id, then syncs', async () => {
    const ctx = ctxFor();
    const result = await call('delete_event', { event_id: 'abc123', title: 'dentist appointment', dry_run: false }, ctx);
    expect(result.isError).toBeUndefined();
    expect(ctx.eventPluginWrite.calls).toHaveLength(1);
    const [source, action, event] = ctx.eventPluginWrite.calls[0];
    expect([source.sourceId, action, event]).toEqual(['google-calendar/personal', 'delete', { id: 'abc123' }]);
    expect(ctx.syncSource.calls).toHaveLength(1);
  });

  test('title mismatches, unknown ids and read-only calendars are refused', async () => {
    const ctx = ctxFor();
    const cases = [
      ['delete_event', { event_id: 'abc123', title: 'Team lunch', dry_run: false }, /Title mismatch/],
      ['delete_event', { event_id: 'abc123', dry_run: false }, /title is required/],
      ['delete_event', { event_id: 'nope', title: 'Dentist', dry_run: false }, /No event with id/],
      ['delete_event', { event_id: 'public-calendars/holidays:h1', title: 'Election Day', dry_run: false }, /read-only calendar/],
      ['update_event', { event_id: 'public-calendars/holidays:h1', title: 'Election Day', new_title: 'X', dry_run: false }, /read-only calendar/],
    ];
    for (const [name, args, pattern] of cases) {
      const result = await call(name, args, ctx);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(pattern);
    }
    expect(ctx.eventPluginWrite.calls).toHaveLength(0);
  });

  test('update dry run shows the event and the exact change; moving the start keeps the length', async () => {
    const ctx = ctxFor();
    const result = await call('update_event', { event_id: 'abc123', title: 'Dentist', start: '2026-11-03T10:30', location: 'Oak Ave' }, ctx);
    const out = json(result);
    expect(out.dry_run).toBe(true);
    expect(out.event).toMatchObject({ start: '2026-11-03T09:00:00-05:00', location: 'Main St' });
    expect(out.changes).toEqual({
      location: { from: 'Main St', to: 'Oak Ave' },
      start: { from: '2026-11-03T09:00:00-05:00', to: '2026-11-03T10:30:00-05:00' },
      end: { from: '2026-11-03T10:00:00-05:00', to: '2026-11-03T11:30:00-05:00' },
    });
    expect(ctx.eventPluginWrite.calls).toHaveLength(0);
  });

  test('update with dry_run false sends the change to the plugin', async () => {
    const ctx = ctxFor();
    const result = await call('update_event', {
      event_id: 'google-calendar/personal:abc123', title: 'Dentist', new_title: 'Dentist (cleaning)',
      start: '2026-11-03T10:00', end: '2026-11-03T11:15', timezone: 'America/Los_Angeles', dry_run: false,
    }, ctx);
    expect(result.isError).toBeUndefined();
    const [, action, payload] = ctx.eventPluginWrite.calls[0];
    expect(action).toBe('update');
    expect(payload).toEqual({
      id: 'abc123',
      title: 'Dentist (cleaning)',
      start_date: '2026-11-03T10:00:00-08:00',
      end_date: '2026-11-03T11:15:00-08:00',
      timezone: 'America/Los_Angeles',
    });
    expect(json(result).changes).toMatchObject({
      start: { from: '2026-11-03T09:00:00-05:00', to: '2026-11-03T13:00:00-05:00' },
      timezone: { from: TZ, to: 'America/Los_Angeles' },
    });
    expect(ctx.syncSource.calls).toHaveLength(1);
  });

  test('update refuses empty changes, bad times and zones, and all-day moves', async () => {
    const ctx = ctxFor();
    for (const [args, pattern] of [
      [{ event_id: 'abc123', title: 'Dentist' }, /Nothing to change/],
      [{ event_id: 'abc123', title: 'Dentist', location: 'Main St' }, /Nothing to change/],
      [{ event_id: 'abc123', title: 'Dentist', end: '2026-11-03T08:00' }, /end before it starts/],
      [{ event_id: 'abc123', title: 'Dentist', start: 'soon' }, /Could not read/],
      [{ event_id: 'abc123', title: 'Dentist', start: '2026-11-03T10:00', timezone: 'Mars/Base' }, /Unknown time zone/],
      [{ event_id: 'abc123', title: 'Dentist', location: '' }, /clearing a field/],
      [{ event_id: 'allday1', title: 'Vacation', start: '2026-11-06T09:00' }, /all-day event/],
    ]) {
      const result = await call('update_event', { ...args, dry_run: false }, ctx);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(pattern);
    }
    expect(ctx.eventPluginWrite.calls).toHaveLength(0);
  });

  test('runEventPluginWrite pipes { action, event } to the plugin on stdin', async () => {
    const dir = path.join(workDir, 'fake-plugin');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'write.js'), [
      "let data = '';",
      "process.stdin.on('data', c => { data += c; });",
      "process.stdin.on('end', () => {",
      '  const input = JSON.parse(data);',
      "  console.log('[dotenvx] noise');",
      '  console.log(JSON.stringify({ success: true, got: input, calendar: JSON.parse(process.env.PLUGIN_CONFIG).calendar_id }));',
      '});',
    ].join('\n'));
    const source = { plugin: { name: 'fake', _path: dir, commands: { write: 'write.js' }, settings: {} }, sourceName: 'x', config: { calendar_id: 'cal' } };
    const result = await runEventPluginWrite(source, 'delete', { id: 'abc' });
    expect(result).toEqual({ success: true, got: { action: 'delete', event: { id: 'abc' } }, calendar: 'cal' });
  });

  test('runEventPluginWrite reports a plugin that exits without reading a large payload', async () => {
    const dir = path.join(workDir, 'fake-plugin-early-exit');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'write.js'), "console.error('Error: bad config'); process.exit(3);\n");
    const source = { plugin: { name: 'fake', _path: dir, commands: { write: 'write.js' }, settings: {} }, sourceName: 'x', config: {} };
    const result = await runEventPluginWrite(source, 'update', { id: 'abc', description: 'x'.repeat(8 * 1024 * 1024) });
    expect(result).toEqual({ success: false, error: 'The calendar plugin gave no result: Error: bad config' });
  });
});

describe('categorize_transaction', () => {
  const SOURCE = 'ynab-api/default';
  const meta = (extra = {}) => JSON.stringify({ budget_id: 'b1', ynab_id: 't1', approved: false, ...extra });

  function financeDb() {
    const db = tableDb('finance');
    const insert = db.prepare(`INSERT INTO financial_transactions
      (id, source, date, account, payee, category, category_group, amount, memo, flag, transfer, scheduled, superseded_by, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(`${SOURCE}:b1:t1`, SOURCE, '2026-10-30', 'Checking', 'Joe\'s Diner', '', '', -23.5, '', '', 0, 0, null, meta());
    insert.run(`${SOURCE}:b1:t2`, SOURCE, '2026-10-20', 'Checking', 'Publix', 'Groceries', 'Everyday', -80, '', '', 0, 0, null, meta({ ynab_id: 't2' }));
    insert.run(`${SOURCE}:b1:t3`, SOURCE, '2026-10-21', 'Checking', 'Olive Garden', 'Dining Out', 'Everyday', -40, '', '', 0, 0, null, meta({ ynab_id: 't3' }));
    insert.run(`${SOURCE}:b1:t4`, SOURCE, '2026-10-22', 'Checking', 'Costco', 'Groceries', 'Bulk', -120, '', '', 0, 0, null, meta({ ynab_id: 't4' }));
    insert.run(`${SOURCE}:b1:t5`, SOURCE, '2026-10-23', 'Savings', 'Transfer : Checking', '', '', 100, '', '', 1, 0, null, meta({ ynab_id: 't5' }));
    insert.run('ynab-finance/default:x1', 'ynab-finance/default', '2026-10-30', 'Checking', 'Joe\'s Diner', '', '', -23.5, '', '', 0, 0, null, '{}');
    return db;
  }

  function ctxFor(reply = () => ({ success: true, writeResult: { entry: { payee: 'Joe\'s Diner', category: 'Dining Out' }, updated_fields: ['category', 'approved'] } })) {
    return { db: financeDb(), syncForRead: async () => ({ ok: true }), writeEntryAndSync: recorder(reply) };
  }

  test('a dry run by default: shows the change, sends nothing', async () => {
    const ctx = ctxFor();
    const result = await call('categorize_transaction', { id: `${SOURCE}:b1:t1`, payee: 'Joe\'s', category: 'dining out', approve: true }, ctx);
    expect(text(result)).toMatch(/Dry run: nothing was sent to YNAB/);
    expect(json(result).changes).toEqual({
      category: { from: null, to: 'Everyday: Dining Out' },
      approved: { from: false, to: true },
    });
    expect(ctx.writeEntryAndSync.calls).toHaveLength(0);
  });

  test('with dry_run false, writes through the finance plugin for the row\'s source', async () => {
    const ctx = ctxFor();
    const result = await call('categorize_transaction', {
      id: `${SOURCE}:b1:t1`, payee: 'Joe\'s Diner', category: 'Everyday: Dining Out', memo: 'Lunch', flag: 'Blue', approve: true, dry_run: false,
    }, ctx);
    expect(result.isError).toBeUndefined();
    expect(ctx.writeEntryAndSync.calls).toEqual([[
      'finance',
      { metadata: meta(), category: 'Everyday: Dining Out', memo: 'Lunch', flag: 'blue', approved: true },
      { db: ctx.db, sourceFilter: SOURCE },
    ]]);
    // The payee is only a check; it is never sent, since the plugin would rename the payee.
    expect(ctx.writeEntryAndSync.calls[0][1]).not.toHaveProperty('payee');
  });

  test('refuses wrong payees, unknown or ambiguous categories, and rows YNAB can\'t take', async () => {
    const ctx = ctxFor();
    for (const [args, pattern] of [
      [{ id: `${SOURCE}:b1:t1`, payee: 'Publix', category: 'Dining Out' }, /Title mismatch/],
      [{ id: `${SOURCE}:b1:t1`, category: 'Dining Out' }, /payee is required/],
      [{ id: `${SOURCE}:b1:t1`, payee: 'Joe\'s', category: 'Restaurants' }, /Unknown category "Restaurants"/],
      [{ id: `${SOURCE}:b1:t1`, payee: 'Joe\'s', category: 'Groceries' }, /ambiguous/],
      [{ id: `${SOURCE}:b1:t1`, payee: 'Joe\'s', flag: 'pink' }, /flag must be one of/],
      [{ id: `${SOURCE}:b1:t1`, payee: 'Joe\'s' }, /Nothing to change/],
      [{ id: `${SOURCE}:b1:t5`, payee: 'Transfer', category: 'Groceries' }, /transfer/],
      [{ id: 'ynab-finance/default:x1', payee: 'Joe\'s', category: 'Dining Out' }, /only transactions synced from ynab-api/],
      [{ id: 'nope', payee: 'Joe\'s', category: 'Dining Out' }, /No transaction with id/],
    ]) {
      const result = await call('categorize_transaction', { ...args, dry_run: false }, ctx);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(pattern);
    }
    expect(ctx.writeEntryAndSync.calls).toHaveLength(0);
  });

  test('reports YNAB\'s own refusal and a no-op', async () => {
    const refused = ctxFor(() => ({ success: false, error: 'No category matching "Bulk: Groceries"' }));
    const result = await call('categorize_transaction', { id: `${SOURCE}:b1:t1`, payee: 'Joe\'s', category: 'Bulk: Groceries', dry_run: false }, refused);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Nothing was changed/);

    const same = ctxFor(() => ({ success: true, writeResult: { unchanged: true, message: 'Already in the requested state; nothing sent to YNAB' } }));
    const noop = await call('categorize_transaction', { id: `${SOURCE}:b1:t1`, payee: 'Joe\'s', approve: false, dry_run: false }, same);
    expect(text(noop)).toMatch(/Already in the requested state/);
  });
});
