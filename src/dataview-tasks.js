import fsSync from 'fs';

// Matches tasks including those inside blockquotes (> prefix)
const TASK_REGEX = /^(?:\s*>)*\s*- \[([x\s-])\]\s*(.+)$/gim;

export function parseTasks(content) {
  const tasks = [];
  for (const match of content.matchAll(TASK_REGEX)) {
    const isCompleted = match[1].toLowerCase() === 'x';
    const isCancelled = match[1] === '-';
    tasks.push({
      text: match[2].trim(),
      completed: isCompleted,
      fullyCompleted: isCompleted,
      cancelled: isCancelled,
      status: isCompleted ? 'done' : (isCancelled ? 'cancelled' : 'open')
    });
  }
  return tasks;
}

export function readTasks(fullPath) {
  try {
    return parseTasks(fsSync.readFileSync(fullPath, 'utf-8'));
  } catch {
    return [];
  }
}

// Returns a copy of an index record whose file.tasks is read from disk on
// first access, so queries that never touch tasks don't read every file.
export function withLazyTasks(record, fullPath, wrap = tasks => tasks) {
  let tasks;
  const file = { ...record.file };
  Object.defineProperty(file, 'tasks', {
    enumerable: true,
    get() {
      if (tasks === undefined) tasks = wrap(readTasks(fullPath));
      return tasks;
    }
  });
  return { ...record, file };
}
