/**
 * Checking and unchecking markdown task lines, including making the next
 * occurrence of a 🔁 recurring task.
 *
 * Kept free of the web server so the rules can be unit-tested. The
 * /task/toggle route reads the file, calls toggleTaskInLines(), and writes
 * the result back.
 *
 * Two rules here stop a recurring task from multiplying (issue #688):
 *
 * - Completing a line that is already checked changes nothing. The routes
 *   address a task by line number, and a completed line keeps its number
 *   while its next occurrence is inserted below it. A second "complete" on
 *   the same number (a double tap, two open tabs, a stale page) used to hit
 *   the checked line and insert a second next occurrence.
 * - Completing a recurring task makes no new occurrence when the file already
 *   holds an open copy of the same task with the same rule. Once two open
 *   copies exist, each completion would otherwise keep two chains alive.
 */

import { formatDate } from './date-utils.js';

// Obsidian Tasks date/metadata emoji that terminate a 🔁 recurrence rule.
// Kept in one place so the /task/toggle (parse) and /task/edit (preserve)
// routes can't drift on which tokens end the rule — a mismatch here silently
// breaks recurring-task regeneration (see issue #358). Alternation, not a
// character class, so multi-code-unit emoji (📅 🛫) match correctly.
export const RECURRENCE_TERMINATOR_TOKENS = ['⏳', '📅', '🛫', '✅', '➕'];
export const RECURRENCE_TERMINATOR_PATTERN = `${RECURRENCE_TERMINATOR_TOKENS.join('|')}|#`;

const TASK_LINE = /^(?:\s*>)*\s*- \[[ xX]\]/;
const CHECKED = /^(?:\s*>)*\s*- \[[xX]\]/;
const DATED_TOKEN = /(?:➕|📅|⏳|🛫|✅|❌)\s*\d{4}-\d{2}-\d{2}/g;

/**
 * Parse the 🔁 rule from a task line, or null when the task doesn't recur.
 */
export function getRecurrenceRule(taskLine) {
  const match = taskLine.match(
    new RegExp(`🔁\\s+(.+?)(?:\\s+(?:${RECURRENCE_TERMINATOR_PATTERN})|$)`)
  );
  return match ? match[1].trim() : null;
}

/**
 * Calculate the next date for a recurrence rule such as "every 6 weeks when
 * done", counted from fromDate (YYYY-MM-DD). Returns YYYY-MM-DD or null.
 */
export function calculateNextRecurrence(pattern, fromDate) {
  const baseDate = new Date(fromDate + 'T00:00:00');

  // Remove "when done" if present - it doesn't affect the calculation
  const cleanPattern = pattern.replace(/\s+when\s+done\s*$/i, '').trim();

  const match = cleanPattern.match(/^every\s+(?:(\d+(?:\.\d+)?)\s+)?(day|days|week|weeks|month|months|year|years)$/i);

  if (!match) {
    console.error(`[TASK] Could not parse recurrence pattern: "${pattern}"`);
    return null;
  }

  const quantity = parseFloat(match[1] || '1');
  const unit = match[2].toLowerCase();
  const nextDate = new Date(baseDate);

  switch (unit) {
    case 'day':
    case 'days':
      nextDate.setDate(nextDate.getDate() + Math.round(quantity));
      break;
    case 'week':
    case 'weeks':
      nextDate.setDate(nextDate.getDate() + Math.round(quantity * 7));
      break;
    case 'month':
    case 'months':
      nextDate.setMonth(nextDate.getMonth() + Math.round(quantity));
      break;
    case 'year':
    case 'years':
      nextDate.setFullYear(nextDate.getFullYear() + Math.round(quantity));
      break;
    default:
      console.error(`[TASK] Unsupported recurrence unit: "${unit}"`);
      return null;
  }

  return formatDate(nextDate);
}

/**
 * The part of a task line that names the task: no blockquote prefix,
 * checkbox or dates, with spacing collapsed. Two occurrences of the same
 * recurring task share it even when their fields are in a different order.
 */
export function taskIdentity(taskLine) {
  return taskLine
    .replace(/^(?:\s*>)*\s*- \[[ xX]\]\s*/, '')
    .replace(DATED_TOKEN, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Build the next open occurrence of a recurring task that was just completed.
 */
function buildNextOccurrence(taskLine, recurrencePattern, today) {
  const nextDate = calculateNextRecurrence(recurrencePattern, today);
  if (!nextDate) return null;

  const isWhenDone = /when\s+done/i.test(recurrencePattern);

  let next = taskLine
    .replace(/^((?:\s*>)*\s*)- \[[ xX]\]/, '$1- [ ]')
    .replace(/\s*✅ \d{4}-\d{2}-\d{2}/, '');

  // Update or add scheduled date (⏳)
  if (next.includes('⏳')) {
    next = next.replace(/⏳ \d{4}-\d{2}-\d{2}/, `⏳ ${nextDate}`);
  } else if (next.includes('📅')) {
    next = next.replace(/📅/, `⏳ ${nextDate} 📅`);
  } else if (next.includes('➕')) {
    next = next.replace(/➕/, `⏳ ${nextDate} ➕`);
  } else {
    next = `${next.trimEnd()} ⏳ ${nextDate}`;
  }

  // For "when done" recurrences, advance the due date (📅) to match —
  // otherwise the new instance is due today and re-appears immediately.
  if (isWhenDone && next.includes('📅')) {
    next = next.replace(/📅 \d{4}-\d{2}-\d{2}/, `📅 ${nextDate}`);
  }

  // Give the new task a creation date if the original had none
  if (!next.includes('➕')) {
    next = `${next.trimEnd()} ➕ ${today}`;
  }

  return next.trimEnd();
}

/**
 * Check or uncheck the task on lineNumber (1-based).
 *
 * Returns { lines, updatedLine, newTaskLine, changed } with a new lines
 * array, or { error } when the line is missing or isn't a task. changed is
 * false when the task was already in the requested state; then nothing in
 * lines differs and the caller needn't write the file.
 */
export function toggleTaskInLines(lines, lineNumber, completed, today) {
  const taskLine = lines[lineNumber - 1];
  if (taskLine === undefined) {
    return { error: 'Task line not found' };
  }
  if (!TASK_LINE.test(taskLine)) {
    return { error: 'Not a task line' };
  }

  const isChecked = CHECKED.test(taskLine);
  if (Boolean(completed) === isChecked) {
    return { lines: [...lines], updatedLine: taskLine, newTaskLine: null, changed: false };
  }

  let updatedLine;
  let newTaskLine = null;

  if (completed) {
    updatedLine = `${taskLine
      .replace(/^((?:\s*>)*\s*)- \[ \]/, '$1- [x]')
      .replace(/\s*✅ \d{4}-\d{2}-\d{2}/, '')
      .trimEnd()} ✅ ${today}`;

    const recurrencePattern = getRecurrenceRule(taskLine);
    if (recurrencePattern) {
      const identity = taskIdentity(taskLine);
      const openCopyExists = lines.some((line, index) =>
        index !== lineNumber - 1 &&
        TASK_LINE.test(line) &&
        !CHECKED.test(line) &&
        taskIdentity(line) === identity
      );

      if (openCopyExists) {
        console.log(`[TASK] Not adding a next occurrence: an open copy of this task is already in the file: "${taskLine.trim()}"`);
      } else {
        newTaskLine = buildNextOccurrence(taskLine, recurrencePattern, today);
      }
    }
  } else {
    updatedLine = taskLine
      .replace(/^((?:\s*>)*\s*)- \[[xX]\]/, '$1- [ ]')
      .replace(/\s+✅ \d{4}-\d{2}-\d{2}/, '');
  }

  const newLines = [...lines];
  newLines[lineNumber - 1] = updatedLine;
  if (newTaskLine) {
    newLines.splice(lineNumber, 0, newTaskLine);
  }

  return { lines: newLines, updatedLine, newTaskLine, changed: true };
}
