// Nightly archive + rebalance of alphabetized task files (markdown-tasks
// sources with auto_archive_completed). Run every 15 minutes by the
// scheduler; acts once per night, inside the sleep window, when the task
// files are quiet.

import fs from 'fs';
import path from 'path';
import { getFullConfig, getTimezone, getVaultPath } from './config.js';
import { writeFileAtomic } from './fs-atomic.js';
import { checkQuiet, inWindow, localClock, nightlyWindow, windowNightKey } from './task-files.js';

const STATE_FILE = path.join('.data', 'task-nightly-state.json');

/**
 * Whether the job should act now, and for which night.
 * @returns {{ due: boolean, night: string, reason?: string, window: {start: number, end: number} }}
 */
export function nightlyDecision({ now, timeZone, profile = {}, state = {}, sourceName, force = false }) {
  const window = nightlyWindow({ bedTime: profile.bed_time, wakeTime: profile.wake_time });
  const night = windowNightKey(now, timeZone, window);
  if (force) return { due: true, night, window };
  if (!inWindow(localClock(now, timeZone).minuteOfDay, window)) {
    return { due: false, night, window, reason: 'outside the nightly window' };
  }
  if (state.sources?.[sourceName] === night) {
    return { due: false, night, window, reason: 'already ran tonight' };
  }
  return { due: true, night, window };
}

function readState(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, STATE_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(projectRoot, state) {
  const file = path.join(projectRoot, STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n');
}

function formatClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export async function runNightlyTaskMaintenance({ projectRoot, now = new Date(), force = false, log = console.log } = {}) {
  const config = getFullConfig();
  const timeZone = getTimezone();
  const profile = config.profile || {};
  const state = readState(projectRoot);
  const sources = Object.entries(config.plugins?.['markdown-tasks'] || {})
    .filter(([, sourceConfig]) => sourceConfig.enabled === true && sourceConfig.auto_archive_completed);

  const due = sources
    .map(([sourceName, sourceConfig]) => ({
      sourceName,
      sourceConfig,
      decision: nightlyDecision({ now, timeZone, profile, state, sourceName, force })
    }))
    .filter(({ decision }) => decision.due);
  // Outside the window this runs every 15 minutes with nothing to do; stay silent.
  if (due.length === 0) return { ran: [] };

  // Loaded only when there is work, so the idle ticks stay cheap.
  const { writePluginEntry, tryAcquireSyncLock, releaseSyncLock } = await import('./plugin-loader.js');
  const { getDatabase } = await import('./database-service.js');
  const db = getDatabase(path.join(projectRoot, '.data', 'today.db'));
  const lockedBy = `tasks-nightly:${process.pid}`;
  const ran = [];

  for (const { sourceName, sourceConfig, decision } of due) {
    const sourceId = `markdown-tasks/${sourceName}`;
    const taskFile = path.join(
      projectRoot,
      sourceConfig.default_task_file || path.join(getVaultPath(), 'tasks', 'tasks.md')
    );
    const window = `${formatClock(decision.window.start)}–${formatClock(decision.window.end)}`;

    const quiet = checkQuiet(path.dirname(taskFile), { now: now.getTime() });
    if (!quiet.quiet) {
      log(`${sourceId}: not quiet (${quiet.reason}); will retry before ${formatClock(decision.window.end)}`);
      continue;
    }
    let locked;
    try {
      locked = tryAcquireSyncLock(db, sourceId, lockedBy);
    } catch (error) {
      // No sync bookkeeping yet means nothing has ever synced this source.
      if (!/no such table/.test(error.message)) throw error;
      locked = null;
    }
    if (locked === false) {
      log(`${sourceId}: a sync is running; will retry`);
      continue;
    }

    let result;
    try {
      result = await writePluginEntry('markdown-tasks', sourceName, {
        action: 'archive-completed',
        max_tasks_per_file: sourceConfig.max_tasks_per_file || 50,
        sort_all: true
      });
    } finally {
      if (locked) releaseSyncLock(db, sourceId, lockedBy);
    }

    if (!result.success) {
      log(`${sourceId}: failed: ${result.error}`);
      continue;
    }
    const data = result.data || {};
    for (const line of data.restored || []) log(`${sourceId}: ↩︎ restored lost task: ${line}`);
    for (const line of data.removed || []) log(`${sourceId}: ✂︎ removed duplicate task: ${line}`);
    if (data.files_skipped_due_to_conflict?.length) {
      log(`${sourceId}: skipped on conflict: ${data.files_skipped_due_to_conflict.join(', ')}; will retry`);
      continue;
    }
    log(`${sourceId}: night of ${decision.night} (window ${window} ${timeZone}): archived ${data.archived || 0}, `
      + `${data.rebalanced ? `rebalanced (${data.rebalance_info?.files_written} file(s) written)` : 'already in order'}`);

    state.sources = { ...(state.sources || {}), [sourceName]: decision.night };
    writeState(projectRoot, state);
    ran.push(sourceId);
  }

  return { ran };
}
