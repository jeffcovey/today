/**
 * Disk-backed copies of the two volatile timers in the web view.
 *
 * The time tracker in the same bar already survives a restart, because it is
 * backed by the time_logs table and read back through getCurrentTimer(). The
 * Task Timer and the Pomodoro were plain module variables in
 * src/web-server.js, so `bin/today web restart`, a deploy or a crash silently
 * threw away whatever was running (#655). Both are written here on every state
 * transition and read back when the server boots.
 *
 * The file lives in .data/ rather than in the vault, for the same reasons
 * web-preferences.json does: the vault is a git repository and would gather a
 * commit per pause, and today.db is a cache that may be rebuilt. The write
 * follows web-preferences.js rather than inventing anything -- one promise
 * chain so two transitions landing together cannot interleave, and a temp file
 * plus rename so a reader never sees a half-written file. The chain covers one
 * process, which is all there is: the web server is a single process, and the
 * rename keeps even an unexpected second writer to last-one-wins rather than a
 * torn file.
 *
 * Restoring is deliberately conservative. Nothing here advances a timer: it
 * hands back the state as it was saved and lets the server's own
 * advanceTimerIfNeeded() / advancePomodoroIfNeeded() account for the time that
 * passed while the process was down, so there is one catch-up path rather than
 * two. Anything malformed, from a different version, or older than
 * MAX_RESTORE_AGE_MS is discarded instead of resumed.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PHASE_WORK, PHASE_SHORT_REST, PHASE_LONG_REST, createPomodoroState } from './pomodoro.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE_PATH = path.join(__dirname, '..', '.data', 'timer-state.json');

/**
 * Bumped when the saved shape changes in a way an older file cannot satisfy.
 * A file from another version is dropped, not migrated: the most a user loses
 * is one timer, and guessing at an old shape is how absurd state gets
 * restored.
 */
export const STATE_VERSION = 1;

/**
 * How long a saved timer may sit before it is discarded instead of restored.
 *
 * Both timers answer "what am I doing right now", so a stale one is worse than
 * no timer at all: it resumes a session you walked away from hours ago and
 * marches through items or intervals you never asked for. The longest single
 * interval either timer can be configured to hold is 180 minutes (the cap in
 * src/pomodoro.js; the Task Timer's own form stops at 60), so four hours is
 * just past the longest stretch that could still plausibly be mid-interval,
 * and comfortably short of a lunch break, a night, or yesterday.
 *
 * The clock runs from the last state change rather than from the shutdown,
 * which the file has no way to know. That only ever errs towards discarding.
 */
export const MAX_RESTORE_AGE_MS = 4 * 60 * 60 * 1000;

const TASK_TIMER_PHASES = ['work', 'rest'];
const POMODORO_PHASES = [PHASE_WORK, PHASE_SHORT_REST, PHASE_LONG_REST];

/** TODAY_TIMER_STATE overrides the location, as TODAY_WEB_PREFERENCES does. */
export function getTimerStatePath() {
  return process.env.TODAY_TIMER_STATE || DEFAULT_STATE_PATH;
}

let timerWriteChain = Promise.resolve();

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

// ── Task Timer ──────────────────────────────────────────────────────────────

/** seenIds is a Set in the live state, so it needs a hand to reach JSON. */
export function serializeTaskTimer(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    isRunning: Boolean(state.isRunning),
    currentItem: state.currentItem ?? null,
    startTime: state.startTime ?? null,
    duration: state.duration,
    items: Array.isArray(state.items) ? state.items : [],
    currentIndex: state.currentIndex ?? 0,
    phase: state.phase ?? 'work',
    isPaused: Boolean(state.isPaused),
    pausedAt: state.pausedAt ?? null,
    seenIds: [...(state.seenIds instanceof Set ? state.seenIds : [])],
    itemsSeenCount: state.itemsSeenCount ?? 0
  };
}

/**
 * The saved Task Timer as a live state object, or null if it does not describe
 * a timer this version can run. A stopped timer deserializes fine and carries
 * only the chosen duration back, which is the one part of it worth keeping.
 */
export function deserializeTaskTimer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const duration = Number(raw.duration);
  if (!Number.isFinite(duration) || duration < 1) return null;
  if (!TASK_TIMER_PHASES.includes(raw.phase)) return null;
  if (!Array.isArray(raw.items)) return null;
  if (!isNonNegativeInt(raw.currentIndex)) return null;
  if (!isNonNegativeInt(raw.itemsSeenCount)) return null;
  if (!Array.isArray(raw.seenIds)) return null;

  const state = {
    isRunning: Boolean(raw.isRunning),
    currentItem: raw.currentItem ?? null,
    startTime: raw.startTime ?? null,
    duration,
    items: raw.items,
    currentIndex: raw.currentIndex,
    phase: raw.phase,
    isPaused: Boolean(raw.isPaused),
    pausedAt: raw.pausedAt ?? null,
    seenIds: new Set(raw.seenIds),
    itemsSeenCount: raw.itemsSeenCount
  };

  if (!state.isRunning) {
    // Nothing was running; hand back a clean stopped timer that remembers the
    // duration, so the start form does not forget what the user last chose.
    return {
      ...state,
      currentItem: null,
      startTime: null,
      items: [],
      currentIndex: 0,
      phase: 'work',
      isPaused: false,
      pausedAt: null,
      seenIds: new Set(),
      itemsSeenCount: 0
    };
  }

  if (!isIsoTime(state.startTime)) return null;
  if (!state.currentItem || typeof state.currentItem !== 'object') return null;
  if (state.isPaused && !isIsoTime(state.pausedAt)) return null;

  // The item objects went through JSON, so currentItem and items[currentIndex]
  // came back as two copies of the same item. Re-link them: the phase-advance
  // code compares the current item by identity to decide whether to notify.
  const atIndex = state.items[state.currentIndex];
  if (atIndex && atIndex.id === state.currentItem.id) {
    state.currentItem = atIndex;
  }

  return state;
}

// ── Pomodoro ────────────────────────────────────────────────────────────────

/** The pomodoro state is already plain data; this only drops unknown keys. */
export function serializePomodoro(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    isRunning: Boolean(state.isRunning),
    isPaused: Boolean(state.isPaused),
    pausedAt: state.pausedAt ?? null,
    phase: state.phase,
    periodIndex: state.periodIndex,
    startTime: state.startTime ?? null,
    awaitingStart: Boolean(state.awaitingStart),
    finishedPhase: state.finishedPhase ?? null,
    finishedPeriodIndex: state.finishedPeriodIndex ?? 0,
    nudgeCount: state.nudgeCount ?? 0
  };
}

/** The saved pomodoro as a live state object, or null if it is unusable. */
export function deserializePomodoro(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!POMODORO_PHASES.includes(raw.phase)) return null;
  if (!isNonNegativeInt(raw.periodIndex)) return null;
  if (!isNonNegativeInt(raw.nudgeCount)) return null;
  if (raw.finishedPhase !== null && raw.finishedPhase !== undefined &&
      !POMODORO_PHASES.includes(raw.finishedPhase)) return null;

  const state = {
    ...createPomodoroState(),
    isRunning: Boolean(raw.isRunning),
    isPaused: Boolean(raw.isPaused),
    pausedAt: raw.pausedAt ?? null,
    phase: raw.phase,
    periodIndex: raw.periodIndex,
    startTime: raw.startTime ?? null,
    awaitingStart: Boolean(raw.awaitingStart),
    finishedPhase: raw.finishedPhase ?? null,
    finishedPeriodIndex: isNonNegativeInt(raw.finishedPeriodIndex) ? raw.finishedPeriodIndex : 0,
    nudgeCount: raw.nudgeCount
  };

  if (!state.isRunning) return createPomodoroState();

  // A held interval has no start time; a running one must have a real one.
  if (state.awaitingStart) {
    if (state.startTime !== null) return null;
  } else if (!isIsoTime(state.startTime)) {
    return null;
  }
  if (state.isPaused && !isIsoTime(state.pausedAt)) return null;

  return state;
}

// ── File ────────────────────────────────────────────────────────────────────

const NOTHING = Object.freeze({ taskTimer: null, pomodoro: null });

/**
 * Decide what, if anything, a parsed file may restore. Pure, so the staleness
 * rule can be tested without touching the disk.
 *
 * Returns { taskTimer, pomodoro, discarded, ageMs }, where `discarded` names
 * the reason nothing came back: 'malformed', 'version' or 'stale'.
 */
export function restorableTimerState(parsed, now = Date.now()) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...NOTHING, discarded: 'malformed' };
  }
  if (parsed.version !== STATE_VERSION) {
    return { ...NOTHING, discarded: 'version' };
  }
  const savedAt = Date.parse(parsed.savedAt);
  if (!Number.isFinite(savedAt)) {
    return { ...NOTHING, discarded: 'malformed' };
  }

  // A clock that jumped backwards would otherwise read as a state saved in the
  // future; that is the machine's problem, not the timer's, so call it fresh.
  const ageMs = Math.max(0, now - savedAt);
  if (ageMs > MAX_RESTORE_AGE_MS) {
    return { ...NOTHING, discarded: 'stale', ageMs };
  }

  return {
    taskTimer: deserializeTaskTimer(parsed.taskTimer),
    pomodoro: deserializePomodoro(parsed.pomodoro),
    discarded: null,
    ageMs
  };
}

/**
 * Read the saved timers. A missing, unreadable or malformed file is not an
 * error: nothing is restored, which is exactly how the server behaved before.
 */
export async function loadTimerState({ now = Date.now(), statePath = getTimerStatePath() } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(statePath, 'utf-8'));
  } catch {
    return { ...NOTHING, discarded: null };
  }
  return restorableTimerState(parsed, now);
}

/**
 * Replace the file atomically. Queued behind any write already in flight, so
 * two transitions landing together cannot interleave and the file always holds
 * one whole snapshot.
 */
export async function writeTimerState({ taskTimer = null, pomodoro = null, now = new Date() } = {}) {
  const payload = {
    version: STATE_VERSION,
    savedAt: now.toISOString(),
    taskTimer: serializeTaskTimer(taskTimer),
    pomodoro: serializePomodoro(pomodoro)
  };

  const write = timerWriteChain.then(async () => {
    const statePath = getTimerStatePath();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    await fs.rename(tempPath, statePath);
  });
  timerWriteChain = write.catch(() => {});
  await write;
}

/** Remove the saved timers. For tests, and for anything that moves the file. */
export async function deleteTimerState() {
  const write = timerWriteChain.then(async () => {
    await fs.rm(getTimerStatePath(), { force: true });
  });
  timerWriteChain = write.catch(() => {});
  await write;
}
