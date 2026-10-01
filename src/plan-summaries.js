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
  const fm = content.match(/^---(\r\n|\n)([\s\S]*?)(\r\n|\n)---(\r\n|\n|$)/);
  const lineEnding = fm?.[1] ?? content.match(/\r\n|\n/)?.[0] ?? '\n';
  if (!fm) return `---${lineEnding}${newLine}${lineEnding}---${lineEnding}${content}`;

  const lines = fm[2].split(/\r?\n/);
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
  return `---${lineEnding}${lines.join(lineEnding)}${lineEnding}---${fm[4]}${content.slice(fm[0].length)}`;
}

// Top Priorities block in daily plans: marker comment, heading, task lines,
// end marker. Group 2 is the editable body between heading and end marker.
const PRIORITIES_RE = /(<!-- TOP_PRIORITIES:[^\n]*-->\r?\n## 📋 Top Priorities[^\n]*\r?\n)([\s\S]*?)(<!-- \/TOP_PRIORITIES -->)/;

/**
 * Read the Top Priorities section body of a daily plan.
 * @returns {string|null} body without framing blank lines (LF line endings),
 *   or null when the plan has no Top Priorities section.
 */
export function readPriorities(content) {
  if (content == null) return null;
  const m = content.match(PRIORITIES_RE);
  if (!m) return null;
  const body = trimPriorityFramingLines(m[2].replace(/\r\n/g, '\n'));
  return body === '{{PRIORITIES_FROM_DATABASE}}' ? '' : body;
}

function trimPriorityFramingLines(text) {
  const lines = text.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/**
 * Replace the Top Priorities section body, keeping the markers and heading
 * and the file's line endings. Returns content unchanged if there's no section.
 */
export function setPriorities(content, text) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const body = text === '' ? eol : `${eol}${text.split('\n').join(eol)}${eol}${eol}`;
  return content.replace(PRIORITIES_RE, (_, head, _old, tail) => `${head}${body}${tail}`);
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
 * List plans that are in progress today or ended within the last `days`
 * days, and whose summary is blank or not yet committed. Plans covering
 * today are included so their summaries can be drafted during the period.
 * Daily plans are also listed while their Top Priorities section has
 * uncommitted changes, so priorities can be reviewed alongside the summary.
 *
 * @param {object} opts
 * @param {string} opts.vaultPath - Absolute vault root (git work tree).
 * @param {string} [opts.plansDir='plans'] - Plans directory, vault-relative.
 * @param {string} opts.today - YYYY-MM-DD in the user's timezone.
 * @param {number} [opts.days=30]
 * @param {(args: string[]) => string} opts.gitExec - Runs git in the vault.
 * @returns {Array<{file, type, label, start, end, field, summary, status,
 *   inProgress, priorities, prioritiesStatus}>}
 *   status: summary state, 'blank' | 'uncommitted' | null (committed);
 *   inProgress: period includes today; priorities: section body or null when
 *   the plan has none; prioritiesStatus: 'uncommitted' | 'committed' | null.
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
    if (period.start > today || period.end < windowStart) continue;
    candidates.push({ ...period, file: path.posix.join(plansDir, filename) });
  }
  if (candidates.length === 0) return [];

  const status = parseStatus(gitExec(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', plansDir]));

  const results = [];
  for (const plan of candidates) {
    const field = SUMMARY_FIELDS[plan.type];
    const content = fs.readFileSync(path.join(vaultPath, plan.file), 'utf-8');
    const summary = readSummary(content, field);
    const priorities = plan.type === 'day' ? readPriorities(content) : null;

    // HEAD copy, fetched lazily: null when the file is untracked or clean
    // files don't need it (clean means working tree === HEAD).
    let headContent;
    const head = () => {
      if (headContent === undefined) {
        headContent = null;
        const xy = status.get(plan.file);
        if (xy && xy !== '??') {
          try { headContent = gitExec(['show', `HEAD:${plan.file}`]); } catch { headContent = null; }
        }
      }
      return headContent;
    };
    // A part of the file is committed when the file is clean, or HEAD has the
    // same value. Other edits to the file (tasks, notes) don't keep it open.
    const committed = (read, value) => !status.has(plan.file) || (head() !== null && read(head()) === value);

    let planStatus = null;
    if (!summary) planStatus = 'blank';
    else if (!committed((c) => readSummary(c, field), summary)) planStatus = 'uncommitted';

    let prioritiesStatus = null;
    if (priorities !== null) {
      prioritiesStatus = committed(readPriorities, priorities) ? 'committed' : 'uncommitted';
    }

    if (planStatus === null && prioritiesStatus !== 'uncommitted') continue;
    results.push({
      ...plan, field, summary, status: planStatus, inProgress: plan.end >= today, priorities, prioritiesStatus,
    });
  }

  results.sort((a, b) =>
    PLAN_TYPE_ORDER.indexOf(a.type) - PLAN_TYPE_ORDER.indexOf(b.type) || b.end.localeCompare(a.end));
  return results;
}

const httpError = (code, msg) => Object.assign(new Error(msg), { statusCode: code });

function resolvePlanFile({ vaultPath, plansDir, file }) {
  const filename = path.posix.basename(file);
  const period = parsePlanFilename(filename);
  if (!period || file !== path.posix.join(plansDir, filename)) throw httpError(400, 'Not a plan file');
  const absPath = path.join(vaultPath, plansDir, filename);
  if (!fs.existsSync(absPath)) throw httpError(404, 'Plan file not found');
  return { period, absPath };
}

// Read-modify-write with compare-and-swap; on a concurrent edit (e.g. the
// vault watcher touching tasks) recompute from the fresh bytes and retry.
function updateFile(absPath, transform) {
  for (let attempt = 0; ; attempt++) {
    const before = fs.readFileSync(absPath, 'utf-8');
    const after = transform(before);
    if (!writeFileAtomicCAS(absPath, after, before).conflict) return after;
    if (attempt >= 2) throw httpError(409, 'Plan file changed while saving; try again');
  }
}

const normalizeText = (text) => text.replace(/\r\n?/g, '\n').trim();
const normalizePriorities = (text) => trimPriorityFramingLines(text.replace(/\r\n?/g, '\n'));

function isSavedValueCommitted({ gitExec, file, readValue, value }) {
  if (typeof gitExec !== 'function') return false;
  try {
    return readValue(gitExec(['show', `HEAD:${file}`])) === value;
  } catch {
    return false;
  }
}

/**
 * Write a summary into a plan file's frontmatter.
 * @returns {{file: string, summary: string, status: 'blank'|'committed'|'uncommitted'}}
 * @throws {Error} with `.statusCode` for invalid input
 */
export function savePlanSummary({ vaultPath, plansDir = 'plans', file, summary, gitExec }) {
  if (typeof file !== 'string' || typeof summary !== 'string') throw httpError(400, 'file and summary are required');
  const { period, absPath } = resolvePlanFile({ vaultPath, plansDir, file });

  const field = SUMMARY_FIELDS[period.type];
  const after = updateFile(absPath, (before) => setFrontmatterField(before, field, normalizeText(summary)));

  const saved = readSummary(after, field);
  const status = !saved ? 'blank' : isSavedValueCommitted({
    gitExec, file, readValue: (content) => readSummary(content, field), value: saved,
  }) ? 'committed' : 'uncommitted';
  return { file, summary: saved, status };
}

/**
 * Replace the Top Priorities section of a daily plan.
 * @returns {{file: string, priorities: string, status: 'committed'|'uncommitted'}}
 * @throws {Error} with `.statusCode` for invalid input
 */
export function savePlanPriorities({ vaultPath, plansDir = 'plans', file, priorities, gitExec }) {
  if (typeof file !== 'string' || typeof priorities !== 'string') throw httpError(400, 'file and priorities are required');
  const { period, absPath } = resolvePlanFile({ vaultPath, plansDir, file });
  if (period.type !== 'day') throw httpError(400, 'Only daily plans have Top Priorities');

  let hasSection = true;
  const after = updateFile(absPath, (before) => {
    hasSection = readPriorities(before) !== null;
    return hasSection ? setPriorities(before, normalizePriorities(priorities)) : before;
  });
  if (!hasSection) throw httpError(404, 'Plan has no Top Priorities section');

  const saved = readPriorities(after);
  const status = isSavedValueCommitted({ gitExec, file, readValue: readPriorities, value: saved })
    ? 'committed'
    : 'uncommitted';
  return { file, priorities: saved, status };
}
