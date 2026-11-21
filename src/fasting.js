// Fasting timer: read/write fast state in vault/logs/fasting/
//
// Storage:
//   current-fast.md   — one line: ISO 8601 start timestamp (present while a fast is running)
//   YYYY-MM.md        — completed fasts, one per line: start|end|goalHours

import fs from 'fs/promises';
import path from 'path';
import { getAbsoluteVaultPath } from './config.js';
import { getCurrentTimeISO, getConfiguredTimezone } from './date-utils.js';

export const DEFAULT_GOAL_HOURS = 16;
const FASTING_LOG_DIR = path.join('logs', 'fasting');
const CURRENT_FAST_FILE = 'current-fast.md';

function fastingDir() {
  return path.join(getAbsoluteVaultPath(), FASTING_LOG_DIR);
}

function currentFastPath() {
  return path.join(fastingDir(), CURRENT_FAST_FILE);
}

function monthlyLogPath(isoTimestamp) {
  // Returns the path for the monthly log that owns this timestamp's start date.
  const d = new Date(isoTimestamp);
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
  const ts = startTime || getCurrentTimeISO(getConfiguredTimezone());
  await fs.writeFile(currentFastPath(), ts + '\n', 'utf8');
  return ts;
}

// Ends the running fast.
// goalHours: the target (defaults to DEFAULT_GOAL_HOURS; pass null to use the
// goal from whatever the user set when they started — currently we don't store
// it at start time, so the caller supplies it).
// Returns { startTime, endTime, goalHours, durationMs }.
export async function stopFast(goalHours = DEFAULT_GOAL_HOURS) {
  const fast = await getCurrentFast();
  if (!fast) throw new Error('No fast in progress');

  const endTime = getCurrentTimeISO(getConfiguredTimezone());
  const durationMs = new Date(endTime).getTime() - new Date(fast.startTime).getTime();

  const line = `${fast.startTime}|${endTime}|${goalHours}\n`;
  const logFile = monthlyLogPath(fast.startTime);

  // Append to the month file, creating it if it doesn't exist yet.
  try {
    await fs.appendFile(logFile, line, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await fs.writeFile(logFile, line, 'utf8');
  }

  await fs.unlink(currentFastPath());

  return { startTime: fast.startTime, endTime, goalHours, durationMs };
}

// Returns the ISO 8601 end timestamp of the most recent completed fast,
// or null if none found in the current month's log.
export async function getLastFastEnd() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const logFile = path.join(fastingDir(), `${year}-${month}.md`);
  try {
    const content = await fs.readFile(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const parts = lines[lines.length - 1].split('|');
    return parts[1] || null;
  } catch {
    return null;
  }
}
