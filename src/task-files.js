// Helpers for a family of alphabetized task files (tasks.md, tasks-1.md, ...):
// sorted insertion, the open-task ledger that guards a rebalance against a
// file sync reverting some of the files it rewrote, and the nightly window.

import fs from 'fs';
import path from 'path';

const QUIET_MS_DEFAULT = 10 * 60 * 1000;
export const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

export function compareTaskLines(a, b) {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

export function isOpenTaskLine(line) {
  return /^\s*- \[ \]/.test(line);
}

export function isDoneTaskLine(line) {
  return /^\s*- \[x\]/i.test(line);
}

// Identity of a task that survives the metadata the sync hooks add or change
// (priority, created/scheduled/due/done dates, tags).
export function taskKey(line) {
  return line
    .replace(/^\s*- \[.\]\s*/, '')
    .replace(/[🔺⏫🔼🔽⏬]/gu, '')
    .replace(/(➕|⏳|📅|✅|🛫)\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/#[^\s#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The base file and its numbered siblings, in order (tasks-2 before tasks-10).
 * Only files that exist are returned, except the base file, which is always first.
 */
export function listTaskFamily(baseFile) {
  const dir = path.dirname(baseFile);
  const base = path.basename(baseFile, '.md');
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.md$`);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const numbered = names
    .map(name => ({ name, match: name.match(pattern) }))
    .filter(({ match }) => match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map(({ name }) => path.join(dir, name));
  return [baseFile, ...numbered];
}

export function hasNumberedSiblings(baseFile) {
  return listTaskFamily(baseFile).length > 1;
}

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim());
  } catch {
    return [];
  }
}

/**
 * Which file a line belongs in: the last file whose alphabetically-first line
 * sorts at or before it. Empty files are skipped; the first file is the default.
 */
export function chooseTargetIndex(filesLines, line) {
  let target = 0;
  filesLines.forEach((lines, index) => {
    if (lines.length === 0) return;
    const first = lines.reduce((min, l) => (compareTaskLines(l, min) < 0 ? l : min));
    if (compareTaskLines(line, first) >= 0) target = index;
  });
  return target;
}

export function insertSorted(lines, line) {
  const at = lines.findIndex(existing => compareTaskLines(existing, line) > 0);
  const out = [...lines];
  out.splice(at === -1 ? out.length : at, 0, line);
  return out;
}

/**
 * Plan where each new line goes. Returns [{ path, original, lines }] for the
 * files that change; `original` is the exact content read, for a CAS write.
 */
export function planSortedInsert(baseFile, newLines, { skipExisting = false } = {}) {
  const family = listTaskFamily(baseFile);
  const originals = family.map(filePath => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  });
  const filesLines = originals.map(content => (content ?? '').split('\n').filter(line => line.trim()));
  const existing = new Set(filesLines.flat());
  const changed = new Set();

  for (const line of newLines) {
    if (!line.trim()) continue;
    if (skipExisting && existing.has(line)) continue;
    const index = chooseTargetIndex(filesLines, line);
    filesLines[index] = insertSorted(filesLines[index], line);
    existing.add(line);
    changed.add(index);
  }

  return [...changed].sort((a, b) => a - b).map(index => ({
    path: family[index],
    original: originals[index],
    lines: filesLines[index]
  }));
}

/**
 * The ledger written just before a rebalance. Per file it keeps what the
 * rebalance moved in (with the exact line, so it can be put back) and what it
 * moved out (by key, to spot a file that a sync brought back in its old version).
 */
export function buildLedger({ before, after, archiveLength = 0, now = Date.now() }) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const files = {};
  for (const name of names) {
    const pre = new Map((before[name] || []).filter(isOpenTaskLine).map(line => [taskKey(line), line]));
    const post = new Map((after[name] || []).filter(isOpenTaskLine).map(line => [taskKey(line), line]));
    const movedIn = [...post].filter(([key]) => !pre.has(key)).map(([key, line]) => ({ key, line }));
    const movedOut = [...pre.keys()].filter(key => !post.has(key));
    if (movedIn.length || movedOut.length) files[name] = { moved_in: movedIn, moved_out: movedOut };
  }
  return {
    version: 1,
    created_at: new Date(now).toISOString(),
    archive_length: archiveLength,
    files
  };
}

export function ledgerExpired(ledger, now = Date.now()) {
  return !ledger || now - Date.parse(ledger.created_at) > LEDGER_TTL_MS;
}

/**
 * Compare the current files with the ledger.
 *
 * A file counts as reverted when lines the rebalance moved out of it are back
 * in it. For a reverted file, those lines are dropped when their rebalanced
 * copy exists in another file, and the lines the rebalance moved into it are
 * put back if they are gone everywhere and were not completed. A user deleting
 * a task never looks like a revert, so deletions are left alone.
 *
 * Exact duplicate open lines across the files are also reduced to one.
 *
 * @param {object} ledger
 * @param {Array<{name: string, lines: string[]}>} current - files in family order
 * @param {string[]} archiveSince - archive lines appended after the ledger was written
 * @returns {{ files: Object<string, string[]>, restored: string[], removed: string[] }}
 */
export function repairFromLedger(ledger, current, archiveSince = []) {
  const files = Object.fromEntries(current.map(({ name, lines }) => [name, [...lines]]));
  const removed = [];
  const restored = [];
  const changed = new Set();

  const openKeyFiles = () => {
    const map = new Map();
    for (const [name, lines] of Object.entries(files)) {
      for (const line of lines) {
        if (!isOpenTaskLine(line)) continue;
        const key = taskKey(line);
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(name);
      }
    }
    return map;
  };

  const doneKeys = new Set(
    [...Object.values(files).flat(), ...archiveSince].filter(isDoneTaskLine).map(taskKey)
  );

  const toRestore = [];
  for (const [name, entry] of Object.entries(ledger?.files || {})) {
    if (!files[name]) continue;
    const keysHere = new Set(files[name].filter(isOpenTaskLine).map(taskKey));
    const back = entry.moved_out.filter(key => keysHere.has(key));
    if (back.length === 0) continue;

    const where = openKeyFiles();
    const dropKeys = new Set(back.filter(key => [...where.get(key)].some(other => other !== name)));
    if (dropKeys.size) {
      files[name] = files[name].filter(line => {
        if (isOpenTaskLine(line) && dropKeys.has(taskKey(line))) {
          removed.push(line);
          return false;
        }
        return true;
      });
      changed.add(name);
    }

    const whereNow = openKeyFiles();
    for (const { key, line } of entry.moved_in) {
      if (!whereNow.has(key) && !doneKeys.has(key)) toRestore.push(line);
    }
  }

  const seen = new Set();
  for (const { name } of current) {
    const kept = [];
    for (const line of files[name]) {
      if (isOpenTaskLine(line) && seen.has(line)) {
        removed.push(line);
        changed.add(name);
        continue;
      }
      if (isOpenTaskLine(line)) seen.add(line);
      kept.push(line);
    }
    files[name] = kept;
  }

  for (const line of toRestore) {
    if (seen.has(line)) continue;
    const names = current.map(({ name }) => name);
    const index = chooseTargetIndex(names.map(n => files[n]), line);
    files[names[index]] = insertSorted(files[names[index]], line);
    seen.add(line);
    restored.push(line);
    changed.add(names[index]);
  }

  return {
    files: Object.fromEntries([...changed].map(name => [name, files[name]])),
    restored,
    removed
  };
}

/**
 * Whether the task directory looks settled: no task file changed recently and
 * no file-sync temp or backup files are present.
 */
export function checkQuiet(dir, { now = Date.now(), quietMs = QUIET_MS_DEFAULT } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return { quiet: false, reason: `cannot read ${dir}: ${error.message}` };
  }
  const busy = names.find(name =>
    /^\.unison\./.test(name)
    || /\.unison\.tmp$/.test(name)
    || /\.tmp$/.test(name)
    || /\.rebalance-bak-/.test(name)
    || /^\.syncthing\./.test(name)
    || /\.icloud$/.test(name)
  );
  if (busy) return { quiet: false, reason: `sync in progress (${busy})` };

  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    const age = now - stat.mtimeMs;
    if (age < quietMs) {
      return { quiet: false, reason: `${name} changed ${Math.round(age / 1000)}s ago` };
    }
  }
  return { quiet: true };
}

export function parseClockTime(value) {
  const match = typeof value === 'string' && value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

const FALLBACK_WINDOW = { start: 3 * 60, end: 6 * 60 };

/**
 * Minutes of the day when the nightly job may run: from halfway through the
 * sleep hours until wake time. Falls back to 03:00–06:00.
 */
export function nightlyWindow({ bedTime, wakeTime } = {}) {
  const bed = parseClockTime(bedTime);
  const wake = parseClockTime(wakeTime);
  if (bed === null || wake === null) return { ...FALLBACK_WINDOW };
  const sleep = (wake - bed + 1440) % 1440;
  if (sleep === 0) return { ...FALLBACK_WINDOW };
  return { start: (bed + Math.floor(sleep / 2)) % 1440, end: wake };
}

export function inWindow(minuteOfDay, { start, end }) {
  return start <= end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

/** Local date and minute of the day in a time zone. */
export function localClock(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date).map(({ type, value }) => [type, value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

/** The local date the current window opened on, so each night runs once. */
export function windowNightKey(date, timeZone, window) {
  const { date: today, minuteOfDay } = localClock(date, timeZone);
  if (window.start > window.end && minuteOfDay < window.end) {
    return localClock(new Date(date.getTime() - 24 * 60 * 60 * 1000), timeZone).date;
  }
  return today;
}
