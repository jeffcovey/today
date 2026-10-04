import path from 'path';

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

export function normalizeRoutineTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = String(value).trim().match(TIME_RE);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

export function currentHHMM(timeZone, now = new Date()) {
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  // Some ICU versions render midnight as "24:00"
  return hhmm.startsWith('24') ? `00${hhmm.slice(2)}` : hhmm;
}

export function isWithinTimeWindow(hhmm, startTime, endTime) {
  const start = normalizeRoutineTime(startTime);
  const end = normalizeRoutineTime(endTime);
  if (start && hhmm < start) return false;
  if (end && hhmm >= end) return false;
  return true;
}

// Map of vault-relative routine file path -> { title, startTime, endTime }, from markdown-routines habit rows
export function buildRoutineInfoMap(habitRows) {
  const info = new Map();
  for (const row of habitRows) {
    let meta = {};
    try {
      meta = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      continue;
    }
    if (!meta.file_path) continue;
    info.set(meta.file_path, {
      title: row.title,
      startTime: meta.start_time || null,
      endTime: meta.end_time || null
    });
  }
  return info;
}

export function getRoutineInfoMapForDate(db, today) {
  return buildRoutineInfoMap(db.prepare(`
    SELECT title, metadata FROM habits
    WHERE date = ? AND source LIKE 'markdown-routines/%'
  `).all(today));
}

export function routineTaskFilePath(task, vaultPath) {
  let metadata = {};
  try {
    metadata = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
  } catch {
    return null;
  }
  const filePath = task.filePath || metadata.file_path;
  if (typeof filePath !== 'string') return null;
  const vaultPrefix = `${vaultPath}/`;
  return filePath.startsWith(vaultPrefix) ? filePath.slice(vaultPrefix.length) : filePath;
}

export function routineTitleFromPath(filePath) {
  return path.basename(filePath, '.md').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function isRoutinePath(filePath, routineInfo) {
  return typeof filePath === 'string' && routineInfo?.has(filePath) === true;
}

// Replace open routine steps with one summary per routine file; drop routines outside their time window
export function collapseRoutineTasks(tasks, routineInfo, hhmm) {
  const byFile = new Map();
  const others = [];
  for (const task of tasks) {
    if (!isRoutinePath(task.filePath, routineInfo) || task.isDone || task.isCancelled) {
      others.push(task);
      continue;
    }
    const entry = byFile.get(task.filePath) || { count: 0, happens: null };
    entry.count += 1;
    const happens = task.happens || task.scheduledDate || task.dueDate || null;
    if (happens && (!entry.happens || happens < entry.happens)) entry.happens = happens;
    byFile.set(task.filePath, entry);
  }

  const summaries = [];
  for (const [filePath, { count, happens }] of byFile) {
    const info = routineInfo.get(filePath);
    if (!isWithinTimeWindow(hhmm, info?.startTime, info?.endTime)) continue;
    const title = info?.title || routineTitleFromPath(filePath);
    summaries.push({
      id: null,
      type: 'routine',
      text: title,
      originalText: title,
      isDone: false,
      isCancelled: false,
      scheduledDate: happens,
      dueDate: null,
      doneDate: null,
      priority: 0,
      priorityText: null,
      happens,
      createdDate: null,
      source: 'markdown-routines',
      filePath,
      lineNumber: null,
      file: { path: filePath, filename: path.basename(filePath) },
      remainingSteps: count
    });
  }
  return [...others, ...summaries];
}

// Routines with open steps due/scheduled by `today` that are inside their time window
export function getActiveRoutines(db, { today, hhmm, vaultPath }) {
  const prefix = `markdown-tasks/local:${vaultPath}/`;
  const routineInfo = getRoutineInfoMapForDate(db, today);
  if (routineInfo.size === 0) return [];

  const rows = db.prepare(`
    SELECT id, metadata FROM tasks
    WHERE status = 'open'
      AND (due_date <= ? OR json_extract(metadata, '$.scheduled_date') <= ?)
      AND substr(id, 1, ?) = ?
  `).all(today, today, prefix.length, prefix);

  const counts = new Map();
  for (const task of rows) {
    const filePath = routineTaskFilePath(task, vaultPath);
    if (!routineInfo.has(filePath)) continue;
    counts.set(filePath, (counts.get(filePath) || 0) + 1);
  }
  if (counts.size === 0) return [];

  const active = [];
  for (const [filePath, remainingSteps] of counts) {
    const routine = routineInfo.get(filePath);
    if (!isWithinTimeWindow(hhmm, routine?.startTime, routine?.endTime)) continue;
    active.push({ filePath, title: routine?.title || routineTitleFromPath(filePath), remainingSteps });
  }
  return active.sort((a, b) => a.title.localeCompare(b.title));
}
