/**
 * Plan file names for every level (day, week, month, quarter, year), from a
 * YYYY-MM-DD date and independent of the process time zone.
 *
 * Matches the markdown-plans plugin's naming:
 *   Year:    YYYY_00.md
 *   Quarter: YYYY_Q#_00.md
 *   Month:   YYYY_Q#_MM_00.md
 *   Week:    YYYY_Q#_MM_W##_00.md  (year, quarter and month of the ISO week's Monday)
 *   Day:     YYYY_Q#_MM_W##_DD.md
 */

export const PLAN_LEVELS = ['day', 'week', 'month', 'quarter', 'year'];

const pad = n => String(n).padStart(2, '0');
const quarterOf = month => Math.floor((month - 1) / 3) + 1;

function parseDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) {
    throw new Error(`Invalid date "${dateStr}": expected YYYY-MM-DD`);
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error(`Invalid date "${dateStr}": expected a real calendar date`);
  }
  return { year, month, day, utc };
}

/** ISO week number and the Monday of that week, computed in UTC. */
export function isoWeekOf(dateStr) {
  const { utc } = parseDate(dateStr);
  const dow = utc.getUTCDay() || 7;
  const monday = new Date(utc.getTime() - (dow - 1) * 86400000);
  const thursday = new Date(utc.getTime() + (4 - dow) * 86400000);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / 86400000 / 7) + 1;
  return { week, monday };
}

/**
 * The plan file name for a date at a level.
 * @param {string} dateStr - YYYY-MM-DD
 * @param {'day'|'week'|'month'|'quarter'|'year'} level
 */
export function planFileName(dateStr, level = 'day') {
  const { year, month, day } = parseDate(dateStr);
  const q = quarterOf(month);
  switch (level) {
    case 'year':
      return `${year}_00.md`;
    case 'quarter':
      return `${year}_Q${q}_00.md`;
    case 'month':
      return `${year}_Q${q}_${pad(month)}_00.md`;
    case 'week': {
      const { week, monday } = isoWeekOf(dateStr);
      const wm = monday.getUTCMonth() + 1;
      return `${monday.getUTCFullYear()}_Q${quarterOf(wm)}_${pad(wm)}_W${pad(week)}_00.md`;
    }
    case 'day': {
      const { week } = isoWeekOf(dateStr);
      return `${year}_Q${q}_${pad(month)}_W${pad(week)}_${pad(day)}.md`;
    }
    default:
      throw new Error(`Invalid level "${level}": expected one of ${PLAN_LEVELS.join(', ')}`);
  }
}
