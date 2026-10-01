/**
 * Plan summaries review: find recent plan files whose summary is blank or
 * not yet committed, and write edited summaries back into frontmatter.
 *
 * Backs the /_summaries page (issue #541). A plan stays on the list after its
 * summary is saved and only drops off once the summary is committed to the
 * vault repo, so AI-written summaries get a human review before closing out.
 */

import fs from 'fs';
import path from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { writeFileAtomicCAS } from './fs-atomic.js';

export const SUMMARY_FIELDS = {
  year: 'year_summary',
  quarter: 'quarter_summary',
  month: 'month_summary',
  week: 'week_summary',
  day: 'daily_summary',
};

// Display order on the page: longest periods first.
export const PLAN_TYPE_ORDER = ['year', 'quarter', 'month', 'week', 'day'];

// Placeholder the weekly AI summary writes when it has nothing to go on.
const PLACEHOLDER_SUMMARIES = new Set(['No daily summaries available for this week']);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const shortDate = (d) => `${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;

// Monday of ISO week `week` in ISO year `isoYear`.
function isoWeekMonday(isoYear, week) {
  const jan4 = utcDate(isoYear, 1, 4);
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7; // Monday = 0
  return utcDate(isoYear, 1, 4 - jan4Weekday + (week - 1) * 7);
}

/**
 * Parse a plan filename into its type and period.
 * @param {string} filename - e.g. "2026_Q3_09_W39_25.md"
 * @returns {{type: string, start: string, end: string, label: string} | null}
 */
export function parsePlanFilename(filename) {
  let m;
  if ((m = filename.match(/^(\d{4})_Q[1-4]_(\d{2})_W(\d{2})_(\d{2})\.md$/)) && m[4] !== '00') {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[4])];
    const date = utcDate(year, month, day);
    if (date.getUTCMonth() + 1 !== month) return null;
    const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    return {
      type: 'day',
      start: isoDate(date),
      end: isoDate(date),
      label: `${weekday}, ${MONTH_NAMES[month - 1]} ${day}, ${year}`,
    };
  }
  if ((m = filename.match(/^(\d{4})_Q[1-4]_(\d{2})_W(\d{2})_00\.md$/))) {
    const [year, month, week] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // Week files live under a calendar month, so the ISO year can differ at
    // year boundaries (W01 filed under December, W52/53 under January).
    let isoYear = year;
    if (month === 12 && week === 1) isoYear = year + 1;
    if (month === 1 && week >= 52) isoYear = year - 1;
    const start = isoWeekMonday(isoYear, week);
    const end = new Date(start.getTime() + 6 * 86400000);
    return {
      type: 'week',
      start: isoDate(start),
      end: isoDate(end),
      label: `Week ${week}, ${shortDate(start)} – ${shortDate(end)}, ${end.getUTCFullYear()}`,
    };
  }
  if ((m = filename.match(/^(\d{4})_Q[1-4]_(\d{2})_00\.md$/))) {
    const [year, month] = [Number(m[1]), Number(m[2])];
    if (month < 1 || month > 12) return null;
    return {
      type: 'month',
      start: isoDate(utcDate(year, month, 1)),
      end: isoDate(utcDate(year, month + 1, 0)),
      label: `${MONTH_NAMES[month - 1]} ${year}`,
    };
  }
  if ((m = filename.match(/^(\d{4})_Q([1-4])_00\.md$/))) {
    const [year, quarter] = [Number(m[1]), Number(m[2])];
    return {
      type: 'quarter',
      start: isoDate(utcDate(year, quarter * 3 - 2, 1)),
      end: isoDate(utcDate(year, quarter * 3 + 1, 0)),
      label: `Q${quarter} ${year}`,
    };
  }
  if ((m = filename.match(/^(\d{4})_00\.md$/))) {
    const year = Number(m[1]);
    return { type: 'year', start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
  }
  return null;
}

/**
 * Read a plan's summary from file content. Blank, missing, unparseable and
 * placeholder summaries all come back as ''.
 */
export function readSummary(content, field) {
  if (content == null) return '';
  const { properties } = parseFrontmatter(content);
  const value = properties?.[field];
  if (value == null || typeof value === 'object') return '';
  const text = String(value).trim();
  return PLACEHOLDER_SUMMARIES.has(text) ? '' : text;
}

/**
 * Set a top-level frontmatter field to a string value, leaving every other
 * line untouched. Replaces the field's line plus any indented continuation
 * lines (block scalars, wrapped quoted strings). The value is written as a
 * JSON string, which is always a valid YAML double-quoted scalar.
 */
export function setFrontmatterField(content, field, value) {
  const newLine = value === '' ? `${field}:` : `${field}: ${JSON.stringify(value)}`;
  const fm = content.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!fm) return `---\n${newLine}\n---\n${content}`;

  const lines = fm[1].split('\n');
  const keyRe = new RegExp(`^${field}:`);
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx === -1) {
    lines.push(newLine);
  } else {
    let endIdx = idx + 1;
    while (endIdx < lines.length && (/^\s+\S/.test(lines[endIdx]) || lines[endIdx] === '')) {
      endIdx++;
    }
    // Don't swallow trailing blank lines that separate it from the next key.
    while (endIdx > idx + 1 && lines[endIdx - 1] === '') endIdx--;
    lines.splice(idx, endIdx - idx, newLine);
  }
  return `---\n${lines.join('\n')}\n---${fm[2]}${content.slice(fm[0].length)}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return isoDate(utcDate(y, m, d + days));
}

// Parse `git status --porcelain -z` output into a Map of path → XY status.
function parseStatus(output) {
  const map = new Map();
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    map.set(entry.slice(3), xy);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // skip rename source
  }
  return map;
}

/**
 * List plans whose period ended within the last `days` days before `today`
 * and whose summary is blank or not yet committed.
 *
 * @param {object} opts
 * @param {string} opts.vaultPath - Absolute vault root (git work tree).
 * @param {string} [opts.plansDir='plans'] - Plans directory, vault-relative.
 * @param {string} opts.today - YYYY-MM-DD in the user's timezone.
 * @param {number} [opts.days=30]
 * @param {(args: string[]) => string} opts.gitExec - Runs git in the vault.
 * @returns {Array<{file, type, label, start, end, field, summary, status}>}
 *   status: 'blank' | 'uncommitted'
 */
export function listPlanSummaries({ vaultPath, plansDir = 'plans', today, days = 30, gitExec }) {
  const windowStart = addDays(today, -days);
  const absDir = path.join(vaultPath, plansDir);
  let filenames;
  try {
    filenames = fs.readdirSync(absDir);
  } catch {
    return [];
  }

  const candidates = [];
  for (const filename of filenames) {
    const period = parsePlanFilename(filename);
    if (!period) continue;
    if (period.end >= today || period.end < windowStart) continue;
    candidates.push({ ...period, file: path.posix.join(plansDir, filename) });
  }
  if (candidates.length === 0) return [];

  const status = parseStatus(gitExec(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', plansDir]));

  const results = [];
  for (const plan of candidates) {
    const field = SUMMARY_FIELDS[plan.type];
    const content = fs.readFileSync(path.join(vaultPath, plan.file), 'utf-8');
    const summary = readSummary(content, field);
    let planStatus;
    if (!summary) {
      planStatus = 'blank';
    } else if (!status.has(plan.file)) {
      continue; // clean in git and has a summary: closed out
    } else {
      let headContent = null;
      if (status.get(plan.file) !== '??') {
        try { headContent = gitExec(['show', `HEAD:${plan.file}`]); } catch { headContent = null; }
      }
      // Other edits to the file (tasks, notes) don't keep it open; only an
      // uncommitted change to the summary itself does.
      if (headContent !== null && readSummary(headContent, field) === summary) continue;
      planStatus = 'uncommitted';
    }
    results.push({ ...plan, field, summary, status: planStatus });
  }

  results.sort((a, b) =>
    PLAN_TYPE_ORDER.indexOf(a.type) - PLAN_TYPE_ORDER.indexOf(b.type) || b.end.localeCompare(a.end));
  return results;
}

/**
 * Write a summary into a plan file's frontmatter.
 * @returns {{file: string, summary: string, status: 'blank'|'uncommitted'}}
 * @throws {Error} with `.statusCode` for invalid input
 */
export function savePlanSummary({ vaultPath, plansDir = 'plans', file, summary }) {
  const fail = (code, msg) => Object.assign(new Error(msg), { statusCode: code });
  if (typeof file !== 'string' || typeof summary !== 'string') throw fail(400, 'file and summary are required');

  const filename = path.posix.basename(file);
  const period = parsePlanFilename(filename);
  if (!period || file !== path.posix.join(plansDir, filename)) throw fail(400, 'Not a plan file');

  const absPath = path.join(vaultPath, plansDir, filename);
  if (!fs.existsSync(absPath)) throw fail(404, 'Plan file not found');

  const field = SUMMARY_FIELDS[period.type];
  const text = summary.replace(/\r\n?/g, '\n').trim();
  // Read-modify-write with compare-and-swap; on a concurrent edit (e.g. the
  // vault watcher touching tasks) recompute from the fresh bytes and retry.
  let after;
  for (let attempt = 0; ; attempt++) {
    const before = fs.readFileSync(absPath, 'utf-8');
    after = setFrontmatterField(before, field, text);
    if (!writeFileAtomicCAS(absPath, after, before).conflict) break;
    if (attempt >= 2) throw fail(409, 'Plan file changed while saving; try again');
  }

  const saved = readSummary(after, field);
  return { file, summary: saved, status: saved ? 'uncommitted' : 'blank' };
}
