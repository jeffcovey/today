// Fasting timer: read/write fast state in vault/logs/fasting/
//
// Storage:
//   current-fast.md   — present while a fast is running:
//                         line 1: ISO 8601 start timestamp
//                         line 2: goal hours (optional; the default applies if absent)
//   YYYY-MM.md        — completed fasts, one per line: start|end|goalHours

import fs from 'fs/promises';
import path from 'path';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { getAbsoluteVaultPath, getConfig } from './config.js';
import { getCurrentTimeISO, getConfiguredTimezone } from './date-utils.js';
import { writeFileAtomicAsync } from './fs-atomic.js';

export const DEFAULT_GOAL_HOURS = 16;
const FASTING_LOG_DIR = path.join('logs', 'fasting');
const CURRENT_FAST_FILE = 'current-fast.md';
let transitionQueue = Promise.resolve();

function serializeTransition(operation) {
  const result = transitionQueue.then(operation);
  transitionQueue = result.catch(() => {});
  return result;
}

function isValidTimestamp(timestamp) {
  return typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp));
}

export function isValidGoalHours(goalHours) {
  return typeof goalHours === 'number' && Number.isFinite(goalHours) && goalHours > 0 && goalHours <= 168;
}

// The goal a new fast gets: [fasting] default_goal_hours in config.toml, else 16.
export function getDefaultGoalHours() {
  const configured = Number(getConfig('fasting')?.default_goal_hours);
  return isValidGoalHours(configured) ? configured : DEFAULT_GOAL_HOURS;
}

const NAIVE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// Accepts an ISO 8601 timestamp with an offset, or a naive local one
// ("2026-11-21T19:30", as a datetime-local input sends it), which is read in
// the configured timezone. Returns "yyyy-MM-ddTHH:mm:ss±hh:mm" in that
// timezone, or null if the input isn't a timestamp.
export function normalizeTimestamp(input) {
  if (typeof input !== 'string') return null;
  const tz = getConfiguredTimezone();
  const naive = input.trim().match(NAIVE_LOCAL);
  let ms;
  if (naive) {
    const [, y, mo, d, h, mi, s] = naive.map(Number);
    ms = new TZDate(y, mo - 1, d, h, mi, s || 0, tz).getTime();
  } else if (isValidTimestamp(input)) {
    ms = Date.parse(input);
  } else {
    return null;
  }
  if (!Number.isFinite(ms)) return null;
  return format(new TZDate(ms, tz), "yyyy-MM-dd'T'HH:mm:ssxxx");
}

// "yyyy-MM-ddTHH:mm" in the configured timezone, for a datetime-local input.
export function toLocalInputValue(isoTimestamp) {
  return format(new TZDate(Date.parse(isoTimestamp), getConfiguredTimezone()), "yyyy-MM-dd'T'HH:mm");
}

function fastingDir() {
  return path.join(getAbsoluteVaultPath(), FASTING_LOG_DIR);
}

function currentFastPath() {
  return path.join(fastingDir(), CURRENT_FAST_FILE);
}

function monthlyLogPath(isoTimestamp) {
  // Returns the path for the monthly log that owns this timestamp's start date.
  const d = new TZDate(new Date(isoTimestamp).getTime(), getConfiguredTimezone());
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return path.join(fastingDir(), `${year}-${month}.md`);
}

function serializeCurrentFast({ startTime, goalHours }) {
  return `${startTime}\n${goalHours}\n`;
}

// A start time must not be in the future, and (when known) must come after the
// last completed fast ended, or the log would hold overlapping fasts.
async function validateStartTime(startTime, originalStartTime) {
  const startMs = NAIVE_LOCAL.test(originalStartTime.trim())
    ? Date.parse(startTime)
    : Date.parse(originalStartTime);
  if (startMs > Date.now()) {
    throw new RangeError('Start time is in the future');
  }
  const lastEnd = await getLastFastEnd();
  if (lastEnd && Date.parse(startTime) < Date.parse(lastEnd)) {
    throw new RangeError('Start time is before your last fast ended');
  }
}

// Returns { startTime, goalHours } if a fast is running, null otherwise.
export async function getCurrentFast() {
  let raw;
  try {
    raw = await fs.readFile(currentFastPath(), 'utf8');
  } catch {
    return null;
  }
  const [startLine = '', goalLine = ''] = raw.split(/\r?\n/).map(l => l.trim());
  if (!isValidTimestamp(startLine)) return null;
  const goal = Number(goalLine);
  return {
    startTime: startLine,
    goalHours: goalLine && isValidGoalHours(goal) ? goal : getDefaultGoalHours()
  };
}

// Starts a fast. startTime defaults to now; goalHours to the configured default.
// Returns { startTime, goalHours } as written to current-fast.md.
export async function startFast(startTime = null, goalHours = null) {
  const ts = startTime === null ? null : normalizeTimestamp(startTime);
  if (startTime !== null && !ts) {
    throw new TypeError('startTime must be a valid timestamp');
  }
  if (goalHours !== null && !isValidGoalHours(goalHours)) {
    throw new TypeError('goalHours must be a positive number of hours');
  }

  return serializeTransition(async () => {
    const fast = {
      startTime: ts ?? getCurrentTimeISO(getConfiguredTimezone()),
      goalHours: goalHours ?? getDefaultGoalHours()
    };
    if (ts) await validateStartTime(fast.startTime, startTime);
    await fs.mkdir(fastingDir(), { recursive: true });
    await fs.writeFile(currentFastPath(), serializeCurrentFast(fast), { encoding: 'utf8', flag: 'wx' });
    return fast;
  });
}

// Changes the running fast's start time and/or goal.
// Returns the updated { startTime, goalHours }.
export async function updateFast({ startTime, goalHours } = {}) {
  const ts = startTime === undefined ? undefined : normalizeTimestamp(startTime);
  if (ts === null) throw new TypeError('startTime must be a valid timestamp');
  if (goalHours !== undefined && !isValidGoalHours(goalHours)) {
    throw new TypeError('goalHours must be a positive number of hours');
  }

  return serializeTransition(async () => {
    const fast = await getCurrentFast();
    if (!fast) throw new Error('No fast in progress');
    if (ts !== undefined) {
      await validateStartTime(ts, startTime);
      fast.startTime = ts;
    }
    if (goalHours !== undefined) fast.goalHours = goalHours;
    await writeFileAtomicAsync(currentFastPath(), serializeCurrentFast(fast));
    return fast;
  });
}

// Ends the running fast and appends it to its month's log.
// goalHours overrides the goal stored with the fast, if given.
// Returns { startTime, endTime, goalHours, durationMs }.
export async function stopFast(goalHours = null) {
  if (goalHours !== null && !isValidGoalHours(goalHours)) {
    throw new TypeError('goalHours must be a positive number of hours');
  }

  return serializeTransition(async () => {
    const fast = await getCurrentFast();
    if (!fast) throw new Error('No fast in progress');

    const goal = goalHours ?? fast.goalHours;
    const endTime = getCurrentTimeISO(getConfiguredTimezone());
    const durationMs = new Date(endTime).getTime() - new Date(fast.startTime).getTime();

    const line = `${fast.startTime}|${endTime}|${goal}\n`;
    const logFile = monthlyLogPath(fast.startTime);
    await fs.mkdir(fastingDir(), { recursive: true });

    // Keep the active state until the completed fast has been persisted.
    await fs.appendFile(logFile, line, 'utf8');
    await fs.unlink(currentFastPath());

    return { startTime: fast.startTime, endTime, goalHours: goal, durationMs };
  });
}

// Returns the ISO 8601 end timestamp of the most recent completed fast,
// or null if no valid completed fast is found.
export async function getLastFastEnd() {
  let latestEnd = null;
  let latestEndTime = -Infinity;

  try {
    const files = await fs.readdir(fastingDir());
    for (const file of files) {
      if (!/^\d{4}-\d{2}\.md$/.test(file)) continue;
      const content = await fs.readFile(path.join(fastingDir(), file), 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const endTime = line.split('|')[1];
        if (!isValidTimestamp(endTime)) continue;
        const parsedEndTime = Date.parse(endTime);
        if (parsedEndTime > latestEndTime) {
          latestEnd = endTime;
          latestEndTime = parsedEndTime;
        }
      }
    }
  } catch {
    return latestEnd;
  }

  return latestEnd;
}
