// Postpone logic for Obsidian Tasks-format lines, backing the ⏩ button in the
// web view (issue #531). Pure string/date work so it can be unit tested
// without the web server.

const OPEN_TASK_PATTERN = /^(?:\s*>)*\s*- \[ \]/;
const SCHEDULED_PATTERN = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const DUE_PATTERN = /📅\s*(\d{4}-\d{2}-\d{2})/;

// Calendar-day arithmetic on YYYY-MM-DD strings. Done in UTC so the server's
// local timezone / DST can't shift the result by a day.
function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Whether a task line gets a postpone button: an open task with a scheduled
 * and/or due date.
 * @param {string} line - Raw markdown task line
 * @returns {boolean}
 */
export function isPostponable(line) {
  return OPEN_TASK_PATTERN.test(line) && (SCHEDULED_PATTERN.test(line) || DUE_PATTERN.test(line));
}

/**
 * Postpone a task line.
 *
 * Every scheduled/due date that is today or earlier moves to tomorrow, so the
 * task leaves "due/scheduled today" views. If both are already in the future,
 * the date Obsidian Tasks would pick (due, else scheduled) moves out one day.
 *
 * @param {string} line - Raw markdown task line
 * @param {string} today - Today's date as YYYY-MM-DD
 * @returns {{line: string, scheduledDate: string|null, dueDate: string|null}|null}
 *   The rewritten line and its resulting dates, or null if the line is not postponable.
 */
export function postponeTaskLine(line, today) {
  if (!isPostponable(line)) return null;

  const scheduledMatch = line.match(SCHEDULED_PATTERN);
  const dueMatch = line.match(DUE_PATTERN);
  let scheduledDate = scheduledMatch ? scheduledMatch[1] : null;
  let dueDate = dueMatch ? dueMatch[1] : null;

  const tomorrow = addDays(today, 1);
  const scheduledIsCurrent = scheduledDate !== null && scheduledDate <= today;
  const dueIsCurrent = dueDate !== null && dueDate <= today;

  if (scheduledIsCurrent || dueIsCurrent) {
    if (scheduledIsCurrent) scheduledDate = tomorrow;
    if (dueIsCurrent) dueDate = tomorrow;
  } else if (dueDate !== null) {
    dueDate = addDays(dueDate, 1);
  } else {
    scheduledDate = addDays(scheduledDate, 1);
  }

  let newLine = line;
  if (scheduledDate !== null) newLine = newLine.replace(SCHEDULED_PATTERN, `⏳ ${scheduledDate}`);
  if (dueDate !== null) newLine = newLine.replace(DUE_PATTERN, `📅 ${dueDate}`);

  return { line: newLine, scheduledDate, dueDate };
}
