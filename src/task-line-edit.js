/**
 * Rewrite one Obsidian Tasks-format line: change its title, priority, stage,
 * topics, scheduled or due date, or move its dates to a given day. Pure
 * string work, so it can be tested without a vault. Everything the change
 * doesn't touch (recurrence, created and done dates, other tags, block ids)
 * stays where it was.
 *
 * Used by the MCP update_task and postpone_task tools. The web's ⏩ button
 * uses src/task-postpone.js, which postpone_task also uses for its default.
 */

const TASK_LINE = /^((?:\s*>)*\s*)- \[([ xX-])\] ?(.*)$/;
const PRIORITY_EMOJI = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' };
const PRIORITY_CHARS = '🔺⏫🔼🔽⏬';
const PRIORITY_ANY = /\s*[🔺⏫🔼🔽⏬]️?/gu;
const STAGES = ['front-stage', 'back-stage', 'off-stage'];
const STAGE_TAG = /\s*#stage\/(?:front|back|off)-stage\b/g;
const TOPIC_TAG = /\s*#topic\/[a-z_-]+/g;
const DATE_MARK = { due: '📅', scheduled: '⏳' };
// New markers go before these, so recurrence and created/done dates stay last.
const TAIL_MARKERS = /\s(?=(?:🔁|➕|✅|❌))/u;

export const TASK_PRIORITIES = Object.keys(PRIORITY_EMOJI);
export const TASK_STAGES = STAGES;
export const TOPIC_NAME = /^[a-z_-]+$/;

/** Split a task line into its prefix, checkbox and body, or null. */
export function splitTaskLine(line) {
  const m = String(line ?? '').match(TASK_LINE);
  if (!m) return null;
  return { prefix: m[1], box: m[2], body: m[3] };
}

/** Whether a line is an open task (`- [ ]`). */
export function isOpenTaskLine(line) {
  const parts = splitTaskLine(line);
  return Boolean(parts && parts.box === ' ');
}

/**
 * A task's title as the markdown-tasks plugin reads it: the body without its
 * priority, stage and topic tags, dates and recurrence.
 */
export function taskTitleOf(line) {
  const parts = splitTaskLine(line);
  if (!parts) return null;
  return parts.body
    .replace(/[🔺⏫🔼🔽⏬]️?/u, '')
    .replace(/#stage\/(front-stage|back-stage|off-stage)/, '')
    .replace(/#topic\/[a-z_-]+/g, '')
    .replace(/[📅⏳🛫➕✅❌]️?\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/🔁 [^\s#]+(?:\s+[^\s#]+)*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokens that make up the run of metadata at the end of a task body.
const TRAILING_TOKENS = [
  new RegExp(`\\s*[${PRIORITY_CHARS}]\\uFE0F?$`, 'u'),
  /\s*[📅⏳🛫➕✅❌]️?\s*\d{4}-\d{2}-\d{2}$/u,
  /\s*#[^\s#]+$/u,
  /\s*<!--.*?-->$/u,
  /\s*\^[A-Za-z0-9-]+$/u,
  new RegExp(`\\s*🔁\\uFE0F?\\s+[^${PRIORITY_CHARS}📅⏳🛫➕✅❌#🔁]+$`, 'u'),
];

/** The body split into the title part and the trailing metadata run. */
function splitTitle(body) {
  let rest = body.replace(/\s+$/, '');
  let cut = rest.length;
  for (;;) {
    let matched = false;
    for (const token of TRAILING_TOKENS) {
      const m = rest.slice(0, cut).match(token);
      if (m && m.index > 0) {
        cut = m.index;
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  return { title: rest.slice(0, cut), tail: rest.slice(cut) };
}

function insertMarker(body, marker) {
  const m = body.match(TAIL_MARKERS);
  if (m) return `${body.slice(0, m.index)} ${marker}${body.slice(m.index)}`;
  return `${body.replace(/\s+$/, '')} ${marker}`;
}

function setDate(body, kind, value) {
  const emoji = DATE_MARK[kind];
  const pattern = new RegExp(`\\s*${emoji}\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}`, 'u');
  if (value === null) return body.replace(pattern, '');
  if (pattern.test(body)) {
    return body.replace(new RegExp(`${emoji}\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}`, 'u'), `${emoji} ${value}`);
  }
  return insertMarker(body, `${emoji} ${value}`);
}

/** The scheduled and due dates on a line. */
export function taskDatesOf(line) {
  const text = String(line ?? '');
  return {
    scheduled: text.match(/⏳️?\s*(\d{4}-\d{2}-\d{2})/u)?.[1] ?? null,
    due: text.match(/📅️?\s*(\d{4}-\d{2}-\d{2})/u)?.[1] ?? null,
  };
}

/**
 * Apply changes to a task line. A field left undefined is not touched; null
 * removes it. Callers validate values first (see validateTaskChanges).
 *
 * @param {string} line
 * @param {{title?: string, priority?: string|null, stage?: string|null,
 *   topics?: string[], due_date?: string|null, scheduled_date?: string|null}} changes
 * @returns {string|null} The new line, or null if the line is not a task.
 * @throws {Error} When a new title is asked for but a recurrence sits inside
 *   the old title, so where the title ends can't be told safely.
 */
export function updateTaskLine(line, changes) {
  const parts = splitTaskLine(line);
  if (!parts) return null;
  let body = parts.body;

  if (changes.title !== undefined) {
    const { title, tail } = splitTitle(body);
    if (/🔁/u.test(title)) {
      throw new Error('The task\'s recurrence sits in the middle of its line, so its title can\'t be told apart safely. Nothing was changed.');
    }
    // Keep the priority, tags and dates the old title held inside it.
    const kept = [
      ...(title.match(/[🔺⏫🔼🔽⏬]️?/gu) || []),
      ...(title.match(/#stage\/(?:front|back|off)-stage\b/g) || []),
      ...(title.match(/#topic\/[a-z_-]+/g) || []),
      ...(title.match(/[📅⏳🛫➕✅❌]️?\s*\d{4}-\d{2}-\d{2}/gu) || []),
    ];
    body = [changes.title.trim(), ...kept].join(' ') + tail;
  }

  if (changes.priority !== undefined) {
    body = body.replace(PRIORITY_ANY, '');
    if (changes.priority) body = insertMarker(body, PRIORITY_EMOJI[changes.priority]);
  }

  if (changes.stage !== undefined) {
    body = body.replace(STAGE_TAG, '');
    if (changes.stage) body = insertMarker(body, `#stage/${changes.stage}`);
  }

  if (changes.topics !== undefined) {
    body = body.replace(TOPIC_TAG, '');
    for (const topic of changes.topics) body = insertMarker(body, `#topic/${topic}`);
  }

  if (changes.scheduled_date !== undefined) body = setDate(body, 'scheduled', changes.scheduled_date);
  if (changes.due_date !== undefined) body = setDate(body, 'due', changes.due_date);

  body = body.replace(/[ \t]{2,}/g, ' ').trim();
  return `${parts.prefix}- [${parts.box}] ${body}`;
}

/**
 * Move an open task's scheduled and due dates to `toDate`: each date earlier
 * than it moves to it, and later ones stay.
 *
 * @returns {{line: string, scheduledDate: string|null, dueDate: string|null}
 *   |{error: string}}
 */
export function moveTaskLineTo(line, toDate) {
  if (!isOpenTaskLine(line)) return { error: 'Not an open task' };
  const { scheduled, due } = taskDatesOf(line);
  if (!scheduled && !due) {
    return { error: 'The task has no scheduled or due date to move; use update_task to give it one' };
  }
  const changes = {};
  if (scheduled && scheduled < toDate) changes.scheduled_date = toDate;
  if (due && due < toDate) changes.due_date = toDate;
  if (Object.keys(changes).length === 0) {
    return { error: `The task's dates are already on or after ${toDate}` };
  }
  const newLine = updateTaskLine(line, changes);
  return { line: newLine, ...renameDates(taskDatesOf(newLine)) };
}

function renameDates({ scheduled, due }) {
  return { scheduledDate: scheduled, dueDate: due };
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/**
 * Check and normalise update_task's arguments.
 * "none" (or null) clears a date, the priority or the stage; an empty
 * topics list clears the topics.
 *
 * @returns {{changes: object}|{error: string}}
 */
export function validateTaskChanges(args) {
  const changes = {};
  const problems = [];

  if (args.new_title !== undefined && args.new_title !== null) {
    const title = String(args.new_title).trim();
    if (!title) problems.push('new_title is empty');
    else if (/[\r\n]/.test(title)) problems.push('new_title must be one line');
    else if (title.length > 500) problems.push('new_title is longer than 500 characters');
    else if (/[🔺⏫🔼🔽⏬📅⏳🛫➕✅❌🔁]|#stage\/|#topic\//u.test(title)) {
      problems.push('new_title holds a priority, date, recurrence, stage or topic marker; set those with their own fields');
    } else changes.title = title;
  }

  const clear = v => v === null || (typeof v === 'string' && v.trim().toLowerCase() === 'none');

  for (const field of ['due_date', 'scheduled_date']) {
    if (args[field] === undefined) continue;
    if (clear(args[field])) changes[field] = null;
    else if (typeof args[field] === 'string' && isCalendarDate(args[field].trim())) changes[field] = args[field].trim();
    else problems.push(`${field} must be a date written YYYY-MM-DD, or "none" to remove it`);
  }

  if (args.priority !== undefined) {
    if (clear(args.priority)) changes.priority = null;
    else if (TASK_PRIORITIES.includes(args.priority)) changes.priority = args.priority;
    else problems.push(`priority must be one of ${TASK_PRIORITIES.join(', ')}, or "none"`);
  }

  if (args.stage !== undefined) {
    if (clear(args.stage)) changes.stage = null;
    else if (STAGES.includes(args.stage)) changes.stage = args.stage;
    else problems.push(`stage must be one of ${STAGES.join(', ')}, or "none"`);
  }

  if (args.topics !== undefined) {
    if (!Array.isArray(args.topics)) {
      problems.push('topics must be a list of topic names (an empty list removes them)');
    } else {
      const topics = [];
      for (const raw of args.topics) {
        const name = String(raw ?? '').trim().replace(/^#?topic\//, '').replace(/^#/, '');
        if (!TOPIC_NAME.test(name)) problems.push(`topic "${raw}" must be lowercase letters, "-" or "_"`);
        else if (!topics.includes(name)) topics.push(name);
      }
      changes.topics = topics;
    }
  }

  if (problems.length > 0) return { error: `${problems.join('; ')}. Nothing was changed.` };
  if (Object.keys(changes).length === 0) {
    return { error: 'Give at least one of new_title, due_date, scheduled_date, priority, stage or topics. Nothing was changed.' };
  }
  return { changes };
}
