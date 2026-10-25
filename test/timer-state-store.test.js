import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  STATE_VERSION, MAX_RESTORE_AGE_MS,
  getTimerStatePath, loadTimerState, writeTimerState, deleteTimerState,
  restorableTimerState, serializeTaskTimer, deserializeTaskTimer,
  serializePomodoro, deserializePomodoro
} from '../src/timer-state-store.js';
import {
  startPomodoro, pausePomodoro, holdInterval, getPomodoroConfig,
  PHASE_WORK, PHASE_SHORT_REST
} from '../src/pomodoro.js';

/**
 * Timer state store tests (#655).
 *
 * The restart test in test/timer-restart.test.js proves the whole path through
 * a real server; this file pins the rules that decide what a restart is
 * allowed to bring back: the shape that survives JSON, what counts as
 * malformed, and when a saved timer is too old to resume.
 */

const config = getPomodoroConfig({ enabled: true, work_periods: 4, work_minutes: 25 });

let workDir;
let previousPath;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-timer-state-'));
  previousPath = process.env.TODAY_TIMER_STATE;
  process.env.TODAY_TIMER_STATE = path.join(workDir, '.data', 'timer-state.json');
});

afterEach(() => {
  if (previousPath === undefined) delete process.env.TODAY_TIMER_STATE;
  else process.env.TODAY_TIMER_STATE = previousPath;
  fs.rmSync(workDir, { recursive: true, force: true });
});

const runningTaskTimer = (overrides = {}) => ({
  isRunning: true,
  currentItem: { id: 'task-1', displayText: 'Write the tests' },
  startTime: '2026-10-25T12:00:00.000Z',
  duration: 25,
  items: [{ id: 'task-1', displayText: 'Write the tests' }, { id: 'task-2', displayText: 'Then rest' }],
  currentIndex: 0,
  phase: 'work',
  isPaused: false,
  pausedAt: null,
  seenIds: new Set(['task-1']),
  itemsSeenCount: 1,
  ...overrides
});

const saved = (body, savedAt = new Date().toISOString()) => ({
  version: STATE_VERSION,
  savedAt,
  taskTimer: serializeTaskTimer(body.taskTimer ?? null),
  pomodoro: serializePomodoro(body.pomodoro ?? null)
});

describe('task timer round trip', () => {
  test('seenIds survives JSON as a Set', () => {
    const restored = deserializeTaskTimer(JSON.parse(JSON.stringify(serializeTaskTimer(runningTaskTimer()))));
    expect(restored.seenIds).toBeInstanceOf(Set);
    expect(restored.seenIds.has('task-1')).toBe(true);
  });

  test('keeps the phase, the item index and the start time', () => {
    const state = runningTaskTimer({ phase: 'rest', currentIndex: 1, itemsSeenCount: 2 });
    state.currentItem = state.items[1];
    const restored = deserializeTaskTimer(JSON.parse(JSON.stringify(serializeTaskTimer(state))));
    expect(restored.phase).toBe('rest');
    expect(restored.currentIndex).toBe(1);
    expect(restored.itemsSeenCount).toBe(2);
    expect(restored.startTime).toBe(state.startTime);
    expect(restored.duration).toBe(25);
  });

  test('re-links currentItem to the item at the index, so identity checks hold', () => {
    const restored = deserializeTaskTimer(JSON.parse(JSON.stringify(serializeTaskTimer(runningTaskTimer()))));
    expect(restored.currentItem).toBe(restored.items[restored.currentIndex]);
  });

  test('a paused timer comes back paused, with pausedAt intact', () => {
    const state = runningTaskTimer({ isPaused: true, pausedAt: '2026-10-25T12:10:00.000Z' });
    const restored = deserializeTaskTimer(JSON.parse(JSON.stringify(serializeTaskTimer(state))));
    expect(restored.isPaused).toBe(true);
    expect(restored.pausedAt).toBe('2026-10-25T12:10:00.000Z');
  });

  test('a stopped timer carries only the chosen duration back', () => {
    const restored = deserializeTaskTimer(serializeTaskTimer(
      runningTaskTimer({ isRunning: false, duration: 7 })
    ));
    expect(restored.isRunning).toBe(false);
    expect(restored.duration).toBe(7);
    expect(restored.items).toEqual([]);
    expect(restored.currentItem).toBeNull();
    expect(restored.seenIds.size).toBe(0);
  });

  test.each([
    ['no start time', { startTime: null }],
    ['an unparseable start time', { startTime: 'whenever' }],
    ['no current item', { currentItem: null }],
    ['an unknown phase', { phase: 'lunch' }],
    ['a zero duration', { duration: 0 }],
    ['a negative index', { currentIndex: -1 }],
    ['paused with no pausedAt', { isPaused: true, pausedAt: null }]
  ])('a running timer with %s is not restorable', (_label, overrides) => {
    const raw = serializeTaskTimer(runningTaskTimer());
    Object.assign(raw, overrides);
    expect(deserializeTaskTimer(raw)).toBeNull();
  });

  test('a missing or non-object task timer is not restorable', () => {
    expect(deserializeTaskTimer(null)).toBeNull();
    expect(deserializeTaskTimer([])).toBeNull();
    expect(deserializeTaskTimer('running')).toBeNull();
  });
});

describe('pomodoro round trip', () => {
  test('keeps the phase, the period and the start time', () => {
    const state = { ...startPomodoro(new Date('2026-10-25T12:00:00Z')), periodIndex: 2 };
    const restored = deserializePomodoro(JSON.parse(JSON.stringify(serializePomodoro(state))));
    expect(restored).toMatchObject({
      isRunning: true, phase: PHASE_WORK, periodIndex: 2,
      startTime: '2026-10-25T12:00:00.000Z', awaitingStart: false
    });
  });

  test('a held interval comes back held, naming the one that finished', () => {
    const held = holdInterval(startPomodoro(new Date('2026-10-25T12:00:00Z')), config);
    const restored = deserializePomodoro(JSON.parse(JSON.stringify(serializePomodoro(held))));
    expect(restored.awaitingStart).toBe(true);
    expect(restored.finishedPhase).toBe(PHASE_WORK);
    expect(restored.phase).toBe(PHASE_SHORT_REST);
    expect(restored.startTime).toBeNull();
  });

  test('a paused interval comes back paused', () => {
    const paused = pausePomodoro(startPomodoro(new Date('2026-10-25T12:00:00Z')), new Date('2026-10-25T12:05:00Z'));
    const restored = deserializePomodoro(JSON.parse(JSON.stringify(serializePomodoro(paused))));
    expect(restored.isPaused).toBe(true);
    expect(restored.pausedAt).toBe('2026-10-25T12:05:00.000Z');
  });

  test('a stopped pomodoro comes back as a fresh one', () => {
    const restored = deserializePomodoro(serializePomodoro({ ...startPomodoro(), isRunning: false }));
    expect(restored.isRunning).toBe(false);
    expect(restored.startTime).toBeNull();
  });

  test.each([
    ['an unknown phase', { phase: 'siesta' }],
    ['a fractional period index', { periodIndex: 1.5 }],
    ['no start time while running', { startTime: null }],
    ['a start time while holding', { awaitingStart: true, startTime: '2026-10-25T12:00:00.000Z' }],
    ['paused with no pausedAt', { isPaused: true, pausedAt: null }]
  ])('a running pomodoro with %s is not restorable', (_label, overrides) => {
    const raw = serializePomodoro(startPomodoro(new Date('2026-10-25T12:00:00Z')));
    Object.assign(raw, overrides);
    expect(deserializePomodoro(raw)).toBeNull();
  });
});

describe('staleness', () => {
  const now = Date.parse('2026-10-25T18:00:00Z');

  test('restores a state saved a moment ago', () => {
    const file = saved({ taskTimer: runningTaskTimer(), pomodoro: startPomodoro() },
      new Date(now - 30_000).toISOString());
    const restored = restorableTimerState(file, now);
    expect(restored.discarded).toBeNull();
    expect(restored.taskTimer.isRunning).toBe(true);
    expect(restored.pomodoro.isRunning).toBe(true);
  });

  test('restores a state saved just inside the window', () => {
    const file = saved({ pomodoro: startPomodoro() },
      new Date(now - MAX_RESTORE_AGE_MS + 1000).toISOString());
    expect(restorableTimerState(file, now).discarded).toBeNull();
  });

  test('discards a state saved just outside the window', () => {
    const file = saved({ pomodoro: startPomodoro() },
      new Date(now - MAX_RESTORE_AGE_MS - 1000).toISOString());
    const restored = restorableTimerState(file, now);
    expect(restored.discarded).toBe('stale');
    expect(restored.taskTimer).toBeNull();
    expect(restored.pomodoro).toBeNull();
  });

  test('a pomodoro saved yesterday does not resume today', () => {
    const file = saved({ pomodoro: startPomodoro(new Date(now - 26 * 60 * 60 * 1000)) },
      new Date(now - 26 * 60 * 60 * 1000).toISOString());
    expect(restorableTimerState(file, now).discarded).toBe('stale');
  });

  test('a paused timer left overnight does not resume either', () => {
    const paused = pausePomodoro(startPomodoro(new Date(now - 20 * 60 * 60 * 1000)),
      new Date(now - 19 * 60 * 60 * 1000));
    const file = saved({ pomodoro: paused }, new Date(now - 19 * 60 * 60 * 1000).toISOString());
    expect(restorableTimerState(file, now).discarded).toBe('stale');
  });

  test('a clock that jumped backwards counts as fresh, not as the future', () => {
    const file = saved({ pomodoro: startPomodoro() }, new Date(now + 60 * 60 * 1000).toISOString());
    const restored = restorableTimerState(file, now);
    expect(restored.discarded).toBeNull();
    expect(restored.ageMs).toBe(0);
  });

  test.each([
    ['a file from another version', { ...saved({}), version: STATE_VERSION + 1 }, 'version'],
    ['a file with no savedAt', { ...saved({}), savedAt: undefined }, 'malformed'],
    ['a file with a junk savedAt', { ...saved({}), savedAt: 'yesterday' }, 'malformed'],
    ['an array', [], 'malformed'],
    ['nothing at all', null, 'malformed']
  ])('discards %s', (_label, file, reason) => {
    expect(restorableTimerState(file, now).discarded).toBe(reason);
  });
});

describe('the file on disk', () => {
  test('writes, reads back and deletes', async () => {
    await writeTimerState({ taskTimer: runningTaskTimer(), pomodoro: startPomodoro() });
    expect(fs.existsSync(getTimerStatePath())).toBe(true);

    const restored = await loadTimerState();
    expect(restored.discarded).toBeNull();
    expect(restored.taskTimer.currentItem.id).toBe('task-1');
    expect(restored.pomodoro.isRunning).toBe(true);

    await deleteTimerState();
    expect(fs.existsSync(getTimerStatePath())).toBe(false);
  });

  test('creates .data when it is not there yet', async () => {
    expect(fs.existsSync(path.join(workDir, '.data'))).toBe(false);
    await writeTimerState({ pomodoro: startPomodoro() });
    expect(fs.existsSync(getTimerStatePath())).toBe(true);
  });

  test('a missing file restores nothing and is not an error', async () => {
    const restored = await loadTimerState();
    expect(restored).toMatchObject({ taskTimer: null, pomodoro: null, discarded: null });
  });

  test('a half-written file restores nothing and is not an error', async () => {
    fs.mkdirSync(path.dirname(getTimerStatePath()), { recursive: true });
    fs.writeFileSync(getTimerStatePath(), '{"version": 1, "savedAt": "2026-10');
    const restored = await loadTimerState();
    expect(restored).toMatchObject({ taskTimer: null, pomodoro: null, discarded: null });
  });

  test('leaves no temp files behind', async () => {
    await writeTimerState({ pomodoro: startPomodoro() });
    expect(fs.readdirSync(path.join(workDir, '.data'))).toEqual(['timer-state.json']);
  });

  test('concurrent writes are serialized, and the last one wins whole', async () => {
    const writes = [];
    for (let periodIndex = 0; periodIndex < 25; periodIndex++) {
      writes.push(writeTimerState({
        taskTimer: runningTaskTimer({ itemsSeenCount: periodIndex + 1 }),
        pomodoro: { ...startPomodoro(), periodIndex }
      }));
    }
    await Promise.all(writes);

    // Whole, not interleaved: the file parses, and the two halves agree on
    // which write produced them.
    const file = JSON.parse(fs.readFileSync(getTimerStatePath(), 'utf-8'));
    expect(file.pomodoro.periodIndex).toBe(24);
    expect(file.taskTimer.itemsSeenCount).toBe(25);
    expect(fs.readdirSync(path.join(workDir, '.data'))).toEqual(['timer-state.json']);
  });
});
