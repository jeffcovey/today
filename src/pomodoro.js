// Pomodoro timer: a fixed-interval clock that sits under the Task Timer.
//
// It shares the Task Timer's Pushover path but differs in one structural way:
// it never advances on its own. Every interval ends in a hold until the user
// answers, because the point of a break is lost if the next work period has
// already been running while you were away from the desk.

import { getConfig } from './config.js';

export const PHASE_WORK = 'work';
export const PHASE_SHORT_REST = 'short_rest';
export const PHASE_LONG_REST = 'long_rest';

// Fixed on purpose: a reminder cadence you have to go and reconfigure is a
// reminder nobody ever tunes.
export const NUDGE_INTERVAL_MS = 2 * 60 * 1000;
export const MAX_NUDGES = 5;

const DEFAULT_WORK_PERIODS = 4;
const DEFAULT_WORK_MINUTES = 25;
const DEFAULT_SHORT_REST_MINUTES = 5;
const DEFAULT_LONG_REST_MINUTES = 15;

// today.toml is hand-edited, so a value can arrive absent, as a string, or as
// something that would divide the clock by zero.
function positiveInt(value, fallback, max) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function getPomodoroConfig(raw = getConfig('pomodoro')) {
  const section = raw || {};
  return {
    // Opt-in: an absent section leaves every existing vault untouched.
    enabled: section.enabled === true,
    workPeriods: positiveInt(section.work_periods, DEFAULT_WORK_PERIODS, 12),
    workMinutes: positiveInt(section.work_minutes, DEFAULT_WORK_MINUTES, 180),
    shortRestMinutes: positiveInt(section.short_rest_minutes, DEFAULT_SHORT_REST_MINUTES, 180),
    longRestMinutes: positiveInt(section.long_rest_minutes, DEFAULT_LONG_REST_MINUTES, 180)
  };
}

export function phaseMinutes(phase, config) {
  if (phase === PHASE_WORK) return config.workMinutes;
  if (phase === PHASE_SHORT_REST) return config.shortRestMinutes;
  return config.longRestMinutes;
}

export function phaseDurationMs(phase, config) {
  return phaseMinutes(phase, config) * 60 * 1000;
}

// The interval that follows the one just finished. periodIndex is 0-based and
// counts work periods within the current cycle; the long rest closes a cycle,
// so the work period after it starts a fresh one.
export function nextInterval(phase, periodIndex, config) {
  if (phase === PHASE_WORK) {
    const isLastOfCycle = periodIndex + 1 >= config.workPeriods;
    return { phase: isLastOfCycle ? PHASE_LONG_REST : PHASE_SHORT_REST, periodIndex };
  }
  if (phase === PHASE_SHORT_REST) {
    return { phase: PHASE_WORK, periodIndex: periodIndex + 1 };
  }
  return { phase: PHASE_WORK, periodIndex: 0 };
}

export function phaseLabel(phase) {
  if (phase === PHASE_WORK) return 'Work';
  if (phase === PHASE_SHORT_REST) return 'Short rest';
  return 'Long rest';
}

// ── State machine ───────────────────────────────────────────────────────────
// Pure transitions over a plain state object, so the whole sequence — including
// the hold at the end of an interval — can be tested without a running server.

export function createPomodoroState() {
  return {
    isRunning: false,
    isPaused: false,
    pausedAt: null,
    phase: PHASE_WORK,
    periodIndex: 0,
    startTime: null,
    awaitingStart: false,   // interval over, holding for the user
    finishedPhase: null,    // the interval that just ended, for the banner
    finishedPeriodIndex: 0,
    nudgeCount: 0
  };
}

export function startPomodoro(now = new Date()) {
  return { ...createPomodoroState(), isRunning: true, startTime: now.toISOString() };
}

// Milliseconds left in the running interval, frozen at pausedAt while paused.
export function remainingMs(state, config, now = Date.now()) {
  if (!state.startTime) return 0;
  const reference = state.isPaused ? new Date(state.pausedAt).getTime() : now;
  const elapsed = reference - new Date(state.startTime).getTime();
  return Math.max(0, phaseDurationMs(state.phase, config) - elapsed);
}

export function isIntervalOver(state, config, now = Date.now()) {
  if (!state.isRunning || state.isPaused || state.awaitingStart) return false;
  if (!state.startTime) return false;
  return remainingMs(state, config, now) === 0;
}

// End the current interval and hold. The next interval is chosen straight away
// so the banner and the notification can name it, but it is left unstarted:
// nothing advances until the user says so.
export function holdInterval(state, config) {
  const next = nextInterval(state.phase, state.periodIndex, config);
  return {
    ...state,
    finishedPhase: state.phase,
    finishedPeriodIndex: state.periodIndex,
    phase: next.phase,
    periodIndex: next.periodIndex,
    awaitingStart: true,
    isPaused: false,
    pausedAt: null,
    startTime: null,
    nudgeCount: 0
  };
}

// Begin the interval the hold is waiting on.
export function startHeldInterval(state, now = new Date()) {
  return {
    ...state,
    awaitingStart: false,
    finishedPhase: null,
    nudgeCount: 0,
    startTime: now.toISOString(),
    isPaused: false,
    pausedAt: null
  };
}

// End the running interval and begin the next one immediately, with no hold:
// the user is plainly at the keyboard, so there is nobody to wait for.
export function skipInterval(state, config, now = new Date()) {
  const next = nextInterval(state.phase, state.periodIndex, config);
  return {
    ...state,
    phase: next.phase,
    periodIndex: next.periodIndex,
    awaitingStart: false,
    finishedPhase: null,
    startTime: now.toISOString(),
    isPaused: false,
    pausedAt: null,
    nudgeCount: 0
  };
}

export function pausePomodoro(state, now = new Date()) {
  return { ...state, isPaused: true, pausedAt: now.toISOString() };
}

// Shift startTime forward by however long the pause lasted, so the interval
// keeps the time it had left rather than losing it.
export function resumePomodoro(state, now = Date.now()) {
  const pausedFor = now - new Date(state.pausedAt).getTime();
  return {
    ...state,
    startTime: new Date(new Date(state.startTime).getTime() + pausedFor).toISOString(),
    isPaused: false,
    pausedAt: null
  };
}

// How an interval is named on a button and in a notification.
export function intervalDescription(phase, periodIndex, config) {
  if (phase !== PHASE_WORK) return phaseLabel(phase);
  return `Work period ${periodIndex + 1} of ${config.workPeriods}`;
}
