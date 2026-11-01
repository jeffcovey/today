/**
 * The "High" MCP tools from issue #686: get_plan, timer_status,
 * list_time_entries, habits_today, list_issues, search_tasks, postpone_task
 * and update_task. Handlers are called directly against in-memory databases
 * built from the real schema and a temporary vault.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { clearConfigCache } from '../src/config.js';
import { getTodayDate } from '../src/date-utils.js';
import { getSqlColumns } from '../src/plugin-schemas.js';
import { getRegisteredTools, setRegisteredToolsForTesting } from '../src/mcp-tools/index.js';
import { tools as readTools, searchTasks } from '../src/mcp-tools/day-reads.js';
import { tools as writeTools } from '../src/mcp-tools/task-writes.js';
import { planFileName } from '../src/plan-files.js';
import { getDailyPlanRelativePath } from '../src/plan-utils.js';
import { updateTaskLine, moveTaskLineTo, validateTaskChanges, taskTitleOf } from '../src/task-line-edit.js';
import { addDays, parseInstant, formatInstant } from '../src/mcp-tools/_shared.js';

const TZ = 'America/New_York';
const tool = name => [...readTools, ...writeTools].find(t => t.name === name);
const text = result => result.content.map(c => c.text).join('\n');
const json = result => JSON.parse(result.content[result.content.length - 1].text);

function makeDb(...types) {
  const db = new Database(':memory:');
  const tables = { 'time-logs': 'time_logs', habits: 'habits', issues: 'issues', tasks: 'tasks' };
  for (const type of types) db.exec(`CREATE TABLE ${tables[type]} (${getSqlColumns(type)})`);
  return db;
}

let workDir;
let previousConfig;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-mcp-high-'));
  previousConfig = process.env.TODAY_CONFIG;
  process.env.TODAY_CONFIG = path.join(workDir, 'config.toml');
  fs.writeFileSync(process.env.TODAY_CONFIG, `timezone = "${TZ}"\n`);
  clearConfigCache();
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.TODAY_CONFIG;
  else process.env.TODAY_CONFIG = previousConfig;
  clearConfigCache();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('registry', () => {
  test('loads both modules with the right kinds and plugin types', async () => {
    setRegisteredToolsForTesting(null);
    const registered = await getRegisteredTools();
    const expected = {
      get_plan: ['read', 'context'],
      timer_status: ['read', 'time-logs'],
      list_time_entries: ['read', 'time-logs'],
      habits_today: ['read', 'habits'],
      list_issues: ['read', 'issues'],
      search_tasks: ['read', 'tasks'],
      postpone_task: ['write', 'tasks'],
      update_task: ['write', 'tasks'],
    };
    for (const [name, [kind, pluginType]] of Object.entries(expected)) {
      expect(registered.get(name)).toMatchObject({ kind, pluginType });
    }
    expect(registered.get('postpone_task').inputSchema.required).toEqual(['task_id', 'title']);
    expect(registered.get('update_task').inputSchema.required).toEqual(['task_id', 'title']);
  });
});

describe('shared time helpers', () => {
  test('a timestamp without an offset is wall time in the configured zone, not the host', () => {
    expect(parseInstant('2026-11-01T20:00:00', TZ).toISOString()).toBe('2026-11-02T01:00:00.000Z');
    expect(formatInstant('2026-11-02T01:00:00Z', TZ)).toBe('2026-11-01T20:00:00-05:00');
    expect(formatInstant('2026-07-01T09:30:00-04:00', TZ)).toBe('2026-07-01T09:30:00-04:00');
  });
});

describe('plan file names', () => {
  test('day names match the plugin and the web for awkward dates', () => {
    for (const date of ['2026-10-31', '2025-08-04', '2025-12-29', '2024-12-31', '2027-01-01', '2026-03-08']) {
      expect(planFileName(date, 'day')).toBe(getDailyPlanRelativePath(date, ''));
    }
  });

  test('week, month, quarter and year names', () => {
    expect(planFileName('2026-10-31', 'day')).toBe('2026_Q4_10_W44_31.md');
    expect(planFileName('2025-08-06', 'week')).toBe('2025_Q3_08_W32_00.md');
    // A week that starts in October is filed under October.
    expect(planFileName('2026-11-01', 'week')).toBe('2026_Q4_10_W44_00.md');
    // ISO week 53 of 2026 runs into 2027; its file is the Monday's.
    expect(planFileName('2027-01-01', 'week')).toBe('2026_Q4_12_W53_00.md');
    expect(planFileName('2025-08-06', 'month')).toBe('2025_Q3_08_00.md');
    expect(planFileName('2025-02-10', 'quarter')).toBe('2025_Q1_00.md');
    expect(planFileName('2025-02-10', 'year')).toBe('2025_00.md');
    expect(() => planFileName('2025-02-30', 'day')).toThrow(/real calendar date/);
  });
});

describe('get_plan', () => {
  let plans;
  beforeEach(() => {
    plans = path.join(workDir, 'vault', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(process.env.TODAY_CONFIG,
      `timezone = "${TZ}"\n[plugins.markdown-plans.default]\nenabled = true\nplans_directory = "${plans}"\n`);
    clearConfigCache();
  });
  const ctx = () => ({ vaultPath: path.join(workDir, 'vault') });

  test('reads the day plan from the configured plans directory', async () => {
    fs.writeFileSync(path.join(plans, '2026_Q4_10_W44_31.md'), '# Daily Plan\n\n- focus\n');
    const result = await tool('get_plan').handler({ date: '2026-10-31' }, ctx());
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('The day plan for 2026-10-31 (plans/2026_Q4_10_W44_31.md).');
    expect(result.content[1].text).toBe('# Daily Plan\n\n- focus\n');
  });

  test('reads other levels, and defaults to today', async () => {
    fs.writeFileSync(path.join(plans, '2025_Q3_00.md'), 'quarter');
    const quarter = await tool('get_plan').handler({ date: '2025-08-06', level: 'quarter' }, ctx());
    expect(quarter.content[1].text).toBe('quarter');

    const today = getTodayDate(TZ);
    fs.writeFileSync(path.join(plans, planFileName(today, 'day')), 'today');
    const result = await tool('get_plan').handler({}, ctx());
    expect(result.content[1].text).toBe('today');
  });

  test('says plainly when the file does not exist', async () => {
    const result = await tool('get_plan').handler({ date: '2026-10-30', level: 'week' }, ctx());
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/^There is no week plan containing 2026-10-30: plans\/2026_Q4_10_W44_00\.md does not exist\./);
  });

  test('caps a large file and says it was truncated', async () => {
    const line = `${'x'.repeat(99)}\n`;
    fs.writeFileSync(path.join(plans, '2026_00.md'), line.repeat(2000));
    const result = await tool('get_plan').handler({ date: '2026-05-05', level: 'year' }, ctx());
    expect(result.content[0].text).toMatch(/truncated/);
    expect(Buffer.byteLength(result.content[1].text)).toBeLessThanOrEqual(100 * 1024);
    expect(result.content[1].text.endsWith('\n')).toBe(true);
  });

  test('refuses a bad date or level', async () => {
    expect((await tool('get_plan').handler({ date: '2026-13-01' }, ctx())).isError).toBe(true);
    expect((await tool('get_plan').handler({ level: 'decade' }, ctx())).isError).toBe(true);
  });
});

describe('timer_status and list_time_entries', () => {
  const today = () => getTodayDate(TZ);
  function timeDb() {
    const db = makeDb('time-logs');
    const insert = db.prepare('INSERT INTO time_logs (id, source, start_time, end_time, duration_minutes, description) VALUES (?, ?, ?, ?, ?, ?)');
    const t = today();
    const y = addDays(t, -1);
    insert.run('a', 'markdown-time-tracking/default', `${t}T09:00:00-05:00`, `${t}T10:30:00-05:00`, 90, 'Deep work #topic/programming');
    insert.run('b', 'markdown-time-tracking/default', `${t}T11:00:00-05:00`, `${t}T11:20:00-05:00`, 20, 'Email');
    insert.run('c', 'markdown-time-tracking/default', `${y}T21:00:00-05:00`, `${y}T22:00:00-05:00`, 60, 'Reading #topic/books');
    // Written in UTC: 01:30Z is the previous evening in New York.
    insert.run('d', 'other-tracker/x', `${t}T01:30:00Z`, `${t}T02:00:00Z`, 30, 'Late call #topic/programming');
    insert.run('e', 'markdown-time-tracking/default', `${t}T12:00:00-05:00`, null, 0, 'Writing #topic/writing');
    return db;
  }
  const at = () => new Date(new Date(`${today()}T12:45:00-05:00`).getTime());

  test('timer_status shows the running timer and its elapsed time', async () => {
    const db = timeDb();
    const result = await tool('timer_status').handler({}, { db, now: at() });
    const value = json(result);
    expect(value.user_timezone).toBe(TZ);
    expect(value.timers).toEqual([expect.objectContaining({
      description: 'Writing #topic/writing', elapsed_minutes: 45, elapsed: '45m', topics: ['#topic/writing'],
    })]);
    expect(result.content[0].text).toMatch(/^Tracking "Writing #topic\/writing" since .*T12:00:00-0[45]:00 \(45m\)\.$/);
  });

  test('timer_status says when nothing runs, and passes on a stale-sync note', async () => {
    const db = makeDb('time-logs');
    const syncForRead = async () => ({ complete: false, lastSync: new Date('2026-11-01T12:00:00Z') });
    const result = await tool('timer_status').handler({}, { db, syncForRead });
    expect(result.content[0].text).toMatch(/^Note: a time log sync is still running/);
    expect(result.content[1].text).toBe('No timer running.');
  });

  test('today lists entries, the running timer, and totals by topic', async () => {
    const db = timeDb();
    const value = json(await tool('list_time_entries').handler({}, { db, now: at() }));
    expect(value.entries.map(e => e.description)).toEqual(['Deep work #topic/programming', 'Email', 'Writing #topic/writing']);
    expect(value.entries[2]).toMatchObject({ running: true, end: null, duration_minutes: 45 });
    expect(value.total_minutes).toBe(110);
    expect(value.running_minutes).toBe(45);
    expect(value.totals_by_topic).toEqual([
      { topic: '#topic/programming', minutes: 90, duration: '1h 30m' },
      { topic: '(untagged)', minutes: 20, duration: '20m' },
    ]);
  });

  test('yesterday picks its day in the configured zone, whatever the stored offset', async () => {
    const db = timeDb();
    const value = json(await tool('list_time_entries').handler({ range: 'yesterday' }, { db, now: at() }));
    expect(value.entries.map(e => e.description)).toEqual(['Late call #topic/programming', 'Reading #topic/books']);
    // 20:30 in winter, 21:30 in summer.
    expect(value.entries[0].start).toMatch(/T2[01]:30:00-0[45]:00$/);
    expect(value.total_minutes).toBe(90);
  });

  test('week covers the last 7 days and today, by day; source and date filter', async () => {
    const db = timeDb();
    const week = json(await tool('list_time_entries').handler({ range: 'week' }, { db, now: at() }));
    expect(week.count).toBe(5);
    expect(week.totals_by_day.map(d => d.minutes)).toEqual([90, 110]);

    const only = json(await tool('list_time_entries').handler({ range: 'week', source: 'other' }, { db, now: at() }));
    expect(only.entries.map(e => e.source)).toEqual(['other-tracker/x']);

    const day = await tool('list_time_entries').handler({ date: '2020-01-01' }, { db, now: at() });
    expect(day.content[0].text).toBe('No time entries for 2020-01-01.');
    expect((await tool('list_time_entries').handler({ date: 'Jan 1' }, { db })).isError).toBe(true);
  });
});

describe('habits_today', () => {
  test('lists the day\'s daily habits with status, progress and streak', async () => {
    const db = makeDb('habits');
    const insert = db.prepare('INSERT INTO habits (id, source, habit_id, title, date, status, goal_type, value, category, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const d = '2026-11-01';
    insert.run('1', 'markdown-routines/default', 'r1', 'Morning routine', d, 'pending', 'achieve', 3, 'routines', JSON.stringify({ target_type: 'steps', target_value: 12, current_streak: 4 }));
    insert.run('2', 'streaks-habits/default', 'h1', 'Meditate', d, 'completed', 'achieve', 600, 'health', JSON.stringify({ target_type: 'timer' }));
    insert.run('3', 'streaks-habits/default', 'h2', 'Sugar', d, 'skipped', 'limit', 3, 'health', JSON.stringify({ target_value: 2 }));
    insert.run('4', 'streaks-habits/default', 'h3', 'Weekly review', d, 'pending', 'achieve', null, null, JSON.stringify({ recurrence: 'weekly' }));
    insert.run('5', 'streaks-habits/default', 'h1', 'Meditate', '2026-10-31', 'completed', 'achieve', 600, 'health', '{}');

    const result = await tool('habits_today').handler({ date: d }, { db });
    const value = json(result);
    expect(result.content[0].text).toBe('3 habits for 2026-11-01: 1 skipped, 1 pending, 1 completed.');
    const byTitle = Object.fromEntries(value.habits.map(h => [h.title, h]));
    expect(byTitle['Morning routine']).toMatchObject({ status: 'pending', progress: '3/12', streak: 4 });
    expect(byTitle.Meditate).toMatchObject({ status: 'completed', progress: '10m' });
    expect(byTitle.Sugar).toMatchObject({ progress: '3/2', meaning: 'over the limit' });
    expect(byTitle['Weekly review']).toBeUndefined();

    const filtered = json(await tool('habits_today').handler({ date: d, source: 'routines' }, { db }));
    expect(filtered.habits.map(h => h.title)).toEqual(['Morning routine']);
  });
});

describe('list_issues', () => {
  function issueDb() {
    const db = makeDb('issues');
    const insert = db.prepare('INSERT INTO issues (id, source, title, state, opened_at, url, body, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('healthchecks-io/default:newsletter', 'healthchecks-io/default', 'newsletter is DOWN', 'open', '2026-11-01T03:00:00Z', null, null,
      JSON.stringify({ status: 'down', ping_url: 'https://hc-ping.com/secret-uuid', last_ping: '2026-10-31T03:00:00Z' }));
    for (let i = 1; i <= 12; i++) {
      insert.run(`github-issues/today:${i}`, 'github-issues/today', `Issue ${i}`, 'open', `2026-10-${String(i).padStart(2, '0')}T12:00:00Z`,
        `https://github.com/x/y/issues/${i}`, 'body', JSON.stringify({ labels: ['bug'] }));
    }
    insert.run('github-issues/today:99', 'github-issues/today', 'Old one', 'closed', '2026-09-01T12:00:00Z', null, null, JSON.stringify({ closed_at: '2026-10-20T12:00:00Z' }));
    return db;
  }

  test('groups open issues by source, newest first, with totals, hiding ping URLs', async () => {
    const db = issueDb();
    const result = await tool('list_issues').handler({}, { db });
    const value = json(result);
    expect(result.content[0].text).toBe('13 open issues across 2 sources; showing 11 (at most 10 per source).');
    const gh = value.sources.find(s => s.source === 'github-issues/today');
    expect(gh).toMatchObject({ total: 12, returned: 10, has_more: true });
    expect(gh.issues[0]).toMatchObject({ number: '12', title: 'Issue 12', labels: ['bug'], opened_at: '2026-10-12T08:00:00-04:00' });
    const hc = value.sources.find(s => s.source === 'healthchecks-io/default').issues[0];
    expect(hc.details).toEqual({ status: 'down', last_ping: '2026-10-31T03:00:00Z' });
    expect(JSON.stringify(value)).not.toMatch(/secret-uuid/);
  });

  test('closed issues, source filter and limit', async () => {
    const db = issueDb();
    const closed = json(await tool('list_issues').handler({ state: 'closed' }, { db }));
    expect(closed.sources[0].issues[0]).toMatchObject({ title: 'Old one', closed_at: '2026-10-20T08:00:00-04:00' });
    const some = json(await tool('list_issues').handler({ source: 'github', limit: 2 }, { db }));
    expect(some.sources.map(s => s.returned)).toEqual([2]);
    expect((await tool('list_issues').handler({ state: 'all' }, { db })).isError).toBe(true);
  });
});

describe('search_tasks', () => {
  function taskDb() {
    const db = makeDb('tasks');
    const insert = db.prepare('INSERT INTO tasks (id, source, title, status, priority, due_date, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const today = '2026-11-01';
    const rows = [
      ['t1', 'Call the dentist', 'open', 'high', null, { topics: ['health'], created_date: '2026-10-30' }],
      ['t2', 'Renew 100% of the passport', 'open', 'medium', '2026-11-05', { topics: ['admin'], created_date: '2026-09-01' }],
      ['t3', 'Dentist bill', 'completed', 'low', null, { topics: ['health', 'money'], created_date: '2026-10-31' }],
      ['t4', 'Plan health_insurance', 'open', null, null, { topics: ['health_insurance'], stage: 'back-stage' }],
      ['t5', 'Book the dentist again', 'done', null, null, {}],
    ];
    for (const [id, title, status, priority, due, meta] of rows) {
      insert.run(`markdown-tasks/default:${id}`, 'markdown-tasks/default', title, status, priority, due, JSON.stringify(meta));
    }
    return { db, today };
  }

  test('title words, status and paging shape like list_tasks', () => {
    const { db, today } = taskDb();
    const open = searchTasks(db, { query: 'dentist' }, { today });
    expect(open.tasks.map(t => t.title)).toEqual(['Call the dentist']);
    expect(open).toMatchObject({ total: 1, returned: 1, offset: 0, has_more: false, next_offset: null });
    const all = searchTasks(db, { query: 'DENTIST', status: 'all' }, { today });
    expect(all.total).toBe(3);
    const done = searchTasks(db, { query: 'dentist', status: 'completed' }, { today });
    expect(done.tasks.map(t => t.title).sort()).toEqual(['Book the dentist again', 'Dentist bill']);
    // LIKE wildcards in the query are taken literally.
    expect(searchTasks(db, { query: '100%' }, { today }).total).toBe(1);
    expect(searchTasks(db, { query: '_' }, { today }).total).toBe(1);
  });

  test('topic is matched exactly, and recent tasks come newest first', () => {
    const { db, today } = taskDb();
    expect(searchTasks(db, { topic: '#topic/health', status: 'all' }, { today }).tasks.map(t => t.id))
      .toEqual(['markdown-tasks/default:t1', 'markdown-tasks/default:t3']);
    const recent = searchTasks(db, { created_within_days: 7, status: 'all' }, { today });
    expect(recent.tasks.map(t => t.title)).toEqual(['Dentist bill', 'Call the dentist']);
    expect(recent.created_since).toBe('2026-10-25');
    expect(searchTasks(db, { stage: 'back-stage' }, { today }).total).toBe(1);
  });

  test('the handler pages and says how to get the rest', async () => {
    const { db } = taskDb();
    const result = await tool('search_tasks').handler({ status: 'all', limit: 2 }, { db });
    expect(result.content[0].text).toBe('Showing tasks 1-2 of 5. More exist: call search_tasks again with offset: 2 (and the same filters) for the next page.');
    const next = json(await tool('search_tasks').handler({ status: 'all', limit: 2, offset: 4 }, { db }));
    expect(next).toMatchObject({ returned: 1, has_more: false, user_timezone: TZ });
    expect((await tool('search_tasks').handler({ status: 'nope' }, { db })).isError).toBe(true);
  });
});

describe('task line edits', () => {
  const line = '- [ ] Call Bob #topic/home ⏫ ⏳ 2026-11-01 📅 2026-11-03 🔁 every week ➕ 2026-10-01';

  test('each field changes alone and the rest of the line stays', () => {
    expect(updateTaskLine(line, { title: 'Ring Robert' }))
      .toBe('- [ ] Ring Robert #topic/home ⏫ ⏳ 2026-11-01 📅 2026-11-03 🔁 every week ➕ 2026-10-01');
    expect(updateTaskLine(line, { due_date: null, scheduled_date: '2026-11-05' }))
      .toBe('- [ ] Call Bob #topic/home ⏫ ⏳ 2026-11-05 🔁 every week ➕ 2026-10-01');
    expect(updateTaskLine(line, { priority: 'low', stage: 'back-stage', topics: ['work'] }))
      .toBe('- [ ] Call Bob ⏳ 2026-11-01 📅 2026-11-03 🔽 #stage/back-stage #topic/work 🔁 every week ➕ 2026-10-01');
    expect(updateTaskLine('  > - [x] Done thing ✅ 2026-10-30', { title: 'Done better', due_date: '2026-11-02' }))
      .toBe('  > - [x] Done better 📅 2026-11-02 ✅ 2026-10-30');
    expect(updateTaskLine('not a task', { title: 'x' })).toBeNull();
    expect(taskTitleOf(line)).toBe('Call Bob');
  });

  test('moving to a date moves only the dates before it', () => {
    expect(moveTaskLineTo(line, '2026-11-02')).toEqual({
      line: '- [ ] Call Bob #topic/home ⏫ ⏳ 2026-11-02 📅 2026-11-03 🔁 every week ➕ 2026-10-01',
      scheduledDate: '2026-11-02',
      dueDate: '2026-11-03',
    });
    expect(moveTaskLineTo(line, '2026-11-01').error).toMatch(/already on or after/);
    expect(moveTaskLineTo('- [ ] No dates', '2026-11-02').error).toMatch(/no scheduled or due date/);
  });

  test('validation', () => {
    expect(validateTaskChanges({}).error).toMatch(/at least one/);
    expect(validateTaskChanges({ due_date: '2026-02-30' }).error).toMatch(/YYYY-MM-DD/);
    expect(validateTaskChanges({ new_title: 'Pay 📅 2026-11-01' }).error).toMatch(/own fields/);
    expect(validateTaskChanges({ topics: ['Bad Topic'] }).error).toMatch(/lowercase/);
    expect(validateTaskChanges({ topics: ['#topic/a', 'b', 'a'], priority: 'none', due_date: 'none' }).changes)
      .toEqual({ topics: ['a', 'b'], priority: null, due_date: null });
  });
});

describe('postpone_task and update_task', () => {
  let projectRoot;
  let vaultPath;
  let file;
  let db;
  let refreshed;
  const source = 'markdown-tasks/default';
  const rel = 'vault/tasks/tasks.md';
  const id = n => `${source}:${rel}:${n}`;

  function setup(lines) {
    projectRoot = workDir;
    vaultPath = path.join(workDir, 'vault');
    file = path.join(vaultPath, 'tasks', 'tasks.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n'));
    db = makeDb('tasks');
    const insert = db.prepare('INSERT INTO tasks (id, source, title, status, priority, due_date, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)');
    lines.forEach((line, i) => {
      if (!line.startsWith('- [')) return;
      insert.run(id(i + 1), source, taskTitleOf(line), line.startsWith('- [ ]') ? 'open' : 'completed', null,
        line.match(/📅 (\S+)/)?.[1] ?? null,
        JSON.stringify({ file_path: rel, line_number: i + 1, raw_line: line, scheduled_date: line.match(/⏳ (\S+)/)?.[1] ?? null }));
    });
    refreshed = [];
  }
  const ctx = () => ({
    db, projectRoot, vaultPath,
    refreshTaskFile: async (_db, what) => { refreshed.push(what); return { success: true }; },
  });
  const fileLines = () => fs.readFileSync(file, 'utf8').split('\n');

  test('postpone_task moves today\'s dates to tomorrow and returns the line', async () => {
    const today = getTodayDate(TZ);
    const tomorrow = addDays(today, 1);
    setup(['# Tasks', `- [ ] Call Donald 🔁 every week ⏳ ${today} 📅 ${addDays(today, 5)}`]);
    const result = await tool('postpone_task').handler({ task_id: id(2), title: 'call donald' }, ctx());
    expect(result.isError).toBeUndefined();
    const value = json(result);
    const expected = `- [ ] Call Donald 🔁 every week ⏳ ${tomorrow} 📅 ${addDays(today, 5)}`;
    expect(value).toMatchObject({ new_line: expected, scheduled_date: tomorrow, task_id: id(2), user_timezone: TZ });
    expect(fileLines()[1]).toBe(expected);
    expect(refreshed).toEqual([{ source, file: rel }]);
    const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(id(2));
    expect(JSON.parse(row.metadata)).toMatchObject({ scheduled_date: tomorrow, raw_line: expected });
  });

  test('postpone_task to a given date', async () => {
    const today = getTodayDate(TZ);
    const later = addDays(today, 10);
    setup([`- [ ] Pay the bill 📅 ${today}`]);
    const value = json(await tool('postpone_task').handler({ task_id: id(1), title: 'Pay the bill', to_date: later }, ctx()));
    expect(value.new_line).toBe(`- [ ] Pay the bill 📅 ${later}`);
    expect(db.prepare('SELECT due_date FROM tasks WHERE id = ?').get(id(1)).due_date).toBe(later);

    const past = await tool('postpone_task').handler({ task_id: id(1), title: 'Pay the bill', to_date: '2020-01-01' }, ctx());
    expect(text(past)).toMatch(/before today/);
  });

  test('a title mismatch refuses and changes nothing', async () => {
    const today = getTodayDate(TZ);
    setup([`- [ ] Pay the bill 📅 ${today}`]);
    const before = fs.readFileSync(file, 'utf8');
    for (const name of ['postpone_task', 'update_task']) {
      const result = await tool(name).handler({ task_id: id(1), title: 'Walk the dog', due_date: '2030-01-01' }, ctx());
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/Title mismatch.*Nothing was changed/);
      const missing = await tool(name).handler({ task_id: id(1), due_date: '2030-01-01' }, ctx());
      expect(text(missing)).toMatch(/title is required/);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(refreshed).toEqual([]);
  });

  test('refuses tasks it cannot place: unknown id, other sources, a file outside the vault', async () => {
    setup(['- [ ] Pay the bill 📅 2030-01-01']);
    expect(text(await tool('update_task').handler({ task_id: 'nope', title: 'x', priority: 'high' }, ctx()))).toMatch(/No task with id/);

    db.prepare("INSERT INTO tasks (id, source, title, status) VALUES ('github-issues/x:1', 'github-issues/x', 'Remote task', 'open')").run();
    expect(text(await tool('update_task').handler({ task_id: 'github-issues/x:1', title: 'Remote task', priority: 'high' }, ctx())))
      .toMatch(/Only markdown tasks/);

    const outside = path.join(workDir, 'outside.md');
    fs.writeFileSync(outside, '- [ ] Secret');
    db.prepare('INSERT INTO tasks (id, source, title, status) VALUES (?, ?, ?, ?)').run(`${source}:outside.md:1`, source, 'Secret', 'open');
    const result = await tool('update_task').handler({ task_id: `${source}:outside.md:1`, title: 'Secret', priority: 'high' }, ctx());
    expect(text(result)).toMatch(/not a markdown file in the vault/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('- [ ] Secret');
  });

  test('a task that moved lines is found by its line; a lost one is refused', async () => {
    setup(['- [ ] First task', '- [ ] Second task ⏳ 2030-01-01']);
    // Someone added a line above since the last sync.
    fs.writeFileSync(file, ['- [ ] New one', '- [ ] First task', '- [ ] Second task ⏳ 2030-01-01'].join('\n'));
    const result = await tool('update_task').handler({ task_id: id(2), title: 'Second task', priority: 'high' }, ctx());
    const value = json(result);
    expect(value).toMatchObject({ line_moved: true, line_number: 3, task_id: id(3), new_line: '- [ ] Second task ⏳ 2030-01-01 ⏫' });
    expect(result.content[0].text).toMatch(/moved to line 3/);

    fs.writeFileSync(file, '- [ ] Something else\n');
    const lost = await tool('update_task').handler({ task_id: id(1), title: 'First task', priority: 'low' }, ctx());
    expect(text(lost)).toMatch(/no longer this task.*sync_data/);
    expect(fs.readFileSync(file, 'utf8')).toBe('- [ ] Something else\n');
  });

  test('update_task rewrites the fields given and refreshes the row', async () => {
    setup(['- [ ] Draft report #topic/work 🔼 📅 2030-01-10 ➕ 2026-10-01']);
    const result = await tool('update_task').handler({
      task_id: id(1), title: 'Draft report', new_title: 'Write the report', due_date: '2030-01-12',
      scheduled_date: '2030-01-11', stage: 'back-stage', topics: ['work', 'writing'],
    }, ctx());
    expect(result.isError).toBeUndefined();
    const expected = '- [ ] Write the report 🔼 📅 2030-01-12 #stage/back-stage #topic/work #topic/writing ⏳ 2030-01-11 ➕ 2026-10-01';
    expect(json(result)).toMatchObject({ old_line: '- [ ] Draft report #topic/work 🔼 📅 2030-01-10 ➕ 2026-10-01', new_line: expected });
    expect(fileLines()[0]).toBe(expected);
    const row = db.prepare('SELECT title, due_date, metadata FROM tasks WHERE id = ?').get(id(1));
    expect(row).toMatchObject({ title: 'Write the report', due_date: '2030-01-12' });
    expect(JSON.parse(row.metadata)).toMatchObject({ stage: 'back-stage', topics: ['work', 'writing'], scheduled_date: '2030-01-11' });
  });

  test('update_task refuses bad input before touching the file, and reports no-ops', async () => {
    setup(['- [ ] Draft report ⏫']);
    const before = fs.readFileSync(file, 'utf8');
    expect(text(await tool('update_task').handler({ task_id: id(1), title: 'Draft report', due_date: '1/2/2030' }, ctx()))).toMatch(/YYYY-MM-DD/);
    expect(text(await tool('update_task').handler({ task_id: id(1), title: 'Draft report' }, ctx()))).toMatch(/at least one/);
    const same = await tool('update_task').handler({ task_id: id(1), title: 'Draft report', priority: 'high' }, ctx());
    expect(same.content[0].text).toMatch(/nothing was changed/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(refreshed).toEqual([]);
  });

  test('a failed database refresh is reported, the write stands', async () => {
    setup(['- [ ] Draft report']);
    const result = await tool('update_task').handler({ task_id: id(1), title: 'Draft report', priority: 'low' }, {
      ...ctx(), refreshTaskFile: async () => ({ success: false, message: 'locked' }),
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/re-reading it into the database failed \(locked\)/);
    expect(fileLines()[0]).toBe('- [ ] Draft report 🔽');
  });
});
