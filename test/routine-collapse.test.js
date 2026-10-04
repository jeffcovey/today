import Database from 'better-sqlite3';
import {
  buildRoutineInfoMap,
  collapseRoutineTasks,
  currentHHMM,
  getActiveRoutines,
  isWithinTimeWindow,
  normalizeRoutineTime
} from '../src/routine-collapse.js';

describe('normalizeRoutineTime', () => {
  test('pads single-digit hours', () => {
    expect(normalizeRoutineTime('9:05')).toBe('09:05');
    expect(normalizeRoutineTime('16:00')).toBe('16:00');
  });

  test('rejects empty and malformed values', () => {
    expect(normalizeRoutineTime(null)).toBeNull();
    expect(normalizeRoutineTime('')).toBeNull();
    expect(normalizeRoutineTime('4pm')).toBeNull();
    expect(normalizeRoutineTime('25:00')).toBeNull();
    expect(normalizeRoutineTime('12:60')).toBeNull();
  });
});

describe('isWithinTimeWindow', () => {
  test('no window means always visible', () => {
    expect(isWithinTimeWindow('06:00', null, null)).toBe(true);
  });

  test('start time is inclusive', () => {
    expect(isWithinTimeWindow('15:59', '16:00', null)).toBe(false);
    expect(isWithinTimeWindow('16:00', '16:00', null)).toBe(true);
  });

  test('end time is exclusive', () => {
    expect(isWithinTimeWindow('11:59', null, '12:00')).toBe(true);
    expect(isWithinTimeWindow('12:00', null, '12:00')).toBe(false);
  });

  test('unpadded start time compares correctly', () => {
    expect(isWithinTimeWindow('10:00', '9:00', null)).toBe(true);
    expect(isWithinTimeWindow('08:30', '9:00', null)).toBe(false);
  });
});

describe('currentHHMM', () => {
  test('formats time in the given timezone', () => {
    const now = new Date('2026-10-04T14:05:00Z');
    expect(currentHHMM('America/New_York', now)).toBe('10:05');
    expect(currentHHMM('UTC', new Date('2026-10-04T00:07:00Z'))).toBe('00:07');
  });
});

const step = (filePath, line, extra = {}) => ({
  id: `markdown-tasks/local:vault/${filePath}:${line}`,
  text: `step ${line}`,
  isDone: false,
  isCancelled: false,
  happens: '2026-10-04',
  scheduledDate: '2026-10-04',
  filePath,
  ...extra
});

describe('collapseRoutineTasks', () => {
  const info = new Map([
    ['routines/morning.md', { title: 'Morning Routine', startTime: null, endTime: null }],
    ['routines/evening.md', { title: 'Evening Routine', startTime: '16:00', endTime: null }]
  ]);

  test('replaces each routine’s steps with one summary and keeps other tasks', () => {
    const tasks = [
      step('routines/morning.md', 10),
      step('routines/morning.md', 11),
      step('projects/x.md', 5),
      step('routines/morning.md', 12)
    ];
    const result = collapseRoutineTasks(tasks, info, '10:00');
    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe('projects/x.md');
    expect(result[1]).toMatchObject({
      type: 'routine',
      text: 'Morning Routine',
      filePath: 'routines/morning.md',
      remainingSteps: 3,
      happens: '2026-10-04'
    });
  });

  test('hides routines outside their time window', () => {
    const tasks = [step('routines/evening.md', 1), step('routines/morning.md', 1)];
    expect(collapseRoutineTasks(tasks, info, '06:00').map(t => t.text)).toEqual(['Morning Routine']);
    expect(collapseRoutineTasks(tasks, info, '16:00').map(t => t.text)).toEqual(['Evening Routine', 'Morning Routine']);
  });

  test('leaves done steps alone, so done-task queries are unchanged', () => {
    const done = step('routines/morning.md', 1, { isDone: true });
    expect(collapseRoutineTasks([done], info, '10:00')).toEqual([done]);
  });

  test('falls back to a title derived from the file name', () => {
    const [summary] = collapseRoutineTasks([step('routines/hip-mobility.md', 3)], new Map(), '10:00');
    expect(summary.text).toBe('Hip Mobility');
  });
});

describe('buildRoutineInfoMap', () => {
  test('skips rows without file_path or with bad JSON', () => {
    const map = buildRoutineInfoMap([
      { title: 'A', metadata: JSON.stringify({ file_path: 'routines/a.md', start_time: '16:00' }) },
      { title: 'B', metadata: JSON.stringify({}) },
      { title: 'C', metadata: '{not json' }
    ]);
    expect([...map.keys()]).toEqual(['routines/a.md']);
    expect(map.get('routines/a.md')).toEqual({ title: 'A', startTime: '16:00', endTime: null });
  });
});

describe('getActiveRoutines', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (id TEXT, status TEXT, due_date TEXT, metadata TEXT);
      CREATE TABLE habits (title TEXT, date TEXT, source TEXT, metadata TEXT);
    `);
    const addTask = db.prepare('INSERT INTO tasks VALUES (?, ?, NULL, ?)');
    const sched = d => JSON.stringify({ scheduled_date: d });
    addTask.run('markdown-tasks/local:vault/routines/morning.md:10', 'open', sched('2026-10-04'));
    addTask.run('markdown-tasks/local:vault/routines/morning.md:11', 'open', sched('2026-10-04'));
    addTask.run('markdown-tasks/local:vault/routines/morning.md:12', 'completed', sched('2026-10-04'));
    addTask.run('markdown-tasks/local:vault/routines/evening.md:5', 'open', sched('2026-10-04'));
    addTask.run('markdown-tasks/local:vault/routines/weekly.md:5', 'open', sched('2026-10-10'));
    addTask.run('markdown-tasks/local:vault/projects/x.md:1', 'open', sched('2026-10-04'));

    const addHabit = db.prepare("INSERT INTO habits VALUES (?, '2026-10-04', 'markdown-routines/default', ?)");
    addHabit.run('Morning Routine', JSON.stringify({ file_path: 'routines/morning.md' }));
    addHabit.run('Evening Routine', JSON.stringify({ file_path: 'routines/evening.md', start_time: '16:00' }));
  });

  afterEach(() => db.close());

  test('counts open due steps per routine, respecting time windows and future schedules', () => {
    const morning = getActiveRoutines(db, { today: '2026-10-04', hhmm: '06:00', vaultPath: 'vault' });
    expect(morning).toEqual([{ filePath: 'routines/morning.md', title: 'Morning Routine', remainingSteps: 2 }]);

    const evening = getActiveRoutines(db, { today: '2026-10-04', hhmm: '17:00', vaultPath: 'vault' });
    expect(evening.map(r => r.title)).toEqual(['Evening Routine', 'Morning Routine']);
  });

  test('a routine with every step done is not active', () => {
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id LIKE '%morning.md%'").run();
    const result = getActiveRoutines(db, { today: '2026-10-04', hhmm: '10:00', vaultPath: 'vault' });
    expect(result).toEqual([]);
  });
});
