// Fasting timer: read/write fast state in vault/logs/fasting/
//
// Storage:
//   current-fast.md   — one line: ISO 8601 start timestamp (present while a fast is running)
//   YYYY-MM.md        — completed fasts, one per line: start|end|goalHours

import fs from 'fs/promises';
import path from 'path';
import { TZDate } from '@date-fns/tz';
import { getAbsoluteVaultPath } from './config.js';
import { getCurrentTimeISO, getConfiguredTimezone } from './date-utils.js';

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

// Returns { startTime: string } if a fast is running, null otherwise.
export async function getCurrentFast() {
  try {
    const raw = await fs.readFile(currentFastPath(), 'utf8');
    const startTime = raw.trim();
    if (!startTime) return null;
    // Validate it looks like an ISO timestamp
    if (isNaN(new Date(startTime).getTime())) return null;
    return { startTime };
  } catch {
    return null;
  }
}

// Starts a fast. startTime defaults to now.
// Returns the ISO 8601 timestamp written to current-fast.md.
export async function startFast(startTime = null) {
  if (startTime !== null && !isValidTimestamp(startTime)) {
    throw new TypeError('startTime must be a valid timestamp');
  }

  return serializeTransition(async () => {
    const ts = startTime ?? getCurrentTimeISO(getConfiguredTimezone());
    await fs.mkdir(fastingDir(), { recursive: true });
    await fs.writeFile(currentFastPath(), ts + '\n', { encoding: 'utf8', flag: 'wx' });
    return ts;
  });
}

// Ends the running fast.
// goalHours: the target (defaults to DEFAULT_GOAL_HOURS; pass null to use the
// goal from whatever the user set when they started — currently we don't store
// it at start time, so the caller supplies it).
// Returns { startTime, endTime, goalHours, durationMs }.
export async function stopFast(goalHours = DEFAULT_GOAL_HOURS) {
  if (typeof goalHours !== 'number' || !Number.isFinite(goalHours) || goalHours <= 0) {
    throw new TypeError('goalHours must be a positive finite number');
  }

  return serializeTransition(async () => {
    const fast = await getCurrentFast();
    if (!fast) throw new Error('No fast in progress');

    const endTime = getCurrentTimeISO(getConfiguredTimezone());
    const durationMs = new Date(endTime).getTime() - new Date(fast.startTime).getTime();

    const line = `${fast.startTime}|${endTime}|${goalHours}\n`;
    const logFile = monthlyLogPath(fast.startTime);
    await fs.mkdir(fastingDir(), { recursive: true });

    // Keep the active state until the completed fast has been persisted.
    await fs.appendFile(logFile, line, 'utf8');
    await fs.unlink(currentFastPath());

    return { startTime: fast.startTime, endTime, goalHours, durationMs };
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
