/**
 * Task write tools (issue #686, High): postpone_task, the web's ⏩ button,
 * and update_task, the web's task edit. Both rewrite one line of a markdown
 * task file in the vault, checked against the task's title first, then
 * refresh that file in the database.
 *
 * Only markdown-tasks sources can be changed this way: their task ids are
 * `markdown-tasks/<source>:<file>:<line>`.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAbsoluteVaultPath } from '../config.js';
import { getConfiguredTimezone, getTodayDate } from '../date-utils.js';
import { verifyTitle, jsonResult, errorResult } from '../mcp-safeguards.js';
import { writeFileAtomicCAS } from '../fs-atomic.js';
import { getSourcesForType, syncPluginSource } from '../plugin-loader.js';
import { postponeTaskLine } from '../task-postpone.js';
import {
  splitTaskLine,
  isOpenTaskLine,
  taskTitleOf,
  taskDatesOf,
  updateTaskLine,
  moveTaskLineTo,
  validateTaskChanges,
  TASK_PRIORITIES,
  TASK_STAGES,
} from '../task-line-edit.js';
import { isCalendarDate } from './_shared.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const sameTitle = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  === String(b ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Find a task's line in its file, checked against the database's record.
 * @returns {{ok: true, task, source, file, abs, content, lines, index, shifted}
 *   | {ok: false, error: string}}
 */
export function locateTask(db, args, { projectRoot = PROJECT_ROOT, vaultPath = getAbsoluteVaultPath() } = {}) {
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  if (!taskId) return { ok: false, error: 'task_id is required. Look the task up with list_tasks or search_tasks.' };

  const task = db.prepare('SELECT id, title, status, source, metadata FROM tasks WHERE id = ?').get(taskId);
  if (!task) return { ok: false, error: `No task with id ${taskId}. Look it up with list_tasks or search_tasks first.` };

  const check = verifyTitle(args.title, task.title, { what: 'task' });
  if (!check.ok) return { ok: false, error: check.error };

  if (!String(task.source).startsWith('markdown-tasks/') || !taskId.startsWith(`${task.source}:`)) {
    return { ok: false, error: `Only markdown tasks can be changed this way; ${taskId} comes from ${task.source}. Nothing was changed.` };
  }
  const rest = taskId.slice(task.source.length + 1);
  const colon = rest.lastIndexOf(':');
  const file = colon > 0 ? rest.slice(0, colon) : '';
  const lineNumber = Number(rest.slice(colon + 1));
  if (!file || !Number.isInteger(lineNumber) || lineNumber < 1) {
    return { ok: false, error: `Could not read the file and line from task id ${taskId}. Nothing was changed.` };
  }

  // The file must be a markdown file inside the vault, symlinks resolved.
  const abs = path.resolve(projectRoot, file);
  let real;
  let realVault;
  try {
    real = fs.realpathSync(abs);
    realVault = fs.realpathSync(vaultPath);
  } catch {
    return { ok: false, error: `The task's file ${file} was not found. Call sync_data with plugin_type "tasks" and look the task up again. Nothing was changed.` };
  }
  if (!real.endsWith('.md') || !isInside(real, realVault)) {
    return { ok: false, error: `The task's file ${file} is not a markdown file in the vault. Nothing was changed.` };
  }

  const content = fs.readFileSync(real, 'utf8');
  const lines = content.split('\n');
  let meta = {};
  try { meta = task.metadata ? JSON.parse(task.metadata) : {}; } catch { meta = {}; }

  const matches = line => splitTaskLine(line) !== null && sameTitle(taskTitleOf(line), task.title);
  let index = lineNumber - 1;
  let shifted = false;
  const atLine = lines[index];
  const lineOk = atLine !== undefined && ((meta.raw_line && atLine === meta.raw_line) || matches(atLine));
  if (!lineOk) {
    // The file changed since the last sync: accept the task only if exactly
    // one line in it is this task.
    const found = [];
    lines.forEach((line, i) => {
      if ((meta.raw_line && line === meta.raw_line) || matches(line)) found.push(i);
    });
    if (found.length !== 1) {
      return {
        ok: false,
        error: `Line ${lineNumber} of ${file} is no longer this task${found.length > 1 ? ', and the file has more than one task with its title' : ''}. Call sync_data with plugin_type "tasks" and look the task up again. Nothing was changed.`,
      };
    }
    index = found[0];
    shifted = true;
  }

  return { ok: true, task, source: task.source, file, abs: real, content, lines, index, shifted };
}

/** Re-read the task file into the database, as writeEntryAndSync does after a plugin write. */
async function defaultRefresh(db, { source, file }) {
  const { sources } = await getSourcesForType('tasks');
  const match = sources.find(s => s.sourceId === source);
  if (!match) return { success: false, message: `source ${source} is not enabled` };
  return syncPluginSource(match.plugin, match.sourceName, match.config, { db, vaultPath: getAbsoluteVaultPath() }, {
    fileFilter: file, skipAutoTag: true, _caller: 'mcp-write',
  });
}

/**
 * Write the new line, update the task's row right away, and re-sync the file.
 * @returns {{ok: true, taskId, dbNote}|{ok: false, error}}
 */
async function writeTaskLine(ctx, located, newLine, dbFields) {
  const { lines, index, abs, content, source, file } = located;
  const updated = [...lines];
  updated[index] = newLine;
  const { conflict } = writeFileAtomicCAS(abs, updated.join('\n'), content);
  if (conflict) return { ok: false, error: 'The task file changed while writing; nothing was changed. Try again.' };

  const taskId = `${source}:${file}:${index + 1}`;
  // Date-based reads see the change at once; the re-sync below then rewrites
  // the row from the file.
  if (!located.shifted) {
    try {
      const sets = [];
      const params = [];
      let meta = "json_set(COALESCE(CASE WHEN json_valid(metadata) THEN metadata END, '{}'), '$.raw_line', ?";
      const metaParams = [newLine];
      for (const [key, value] of Object.entries(dbFields)) {
        if (['title', 'priority', 'due_date'].includes(key)) {
          sets.push(`${key} = ?`);
          params.push(value);
        } else {
          meta += `, '$.${key}', ${key === 'topics' ? 'json(?)' : '?'}`;
          metaParams.push(key === 'topics' ? JSON.stringify(value) : value);
        }
      }
      sets.push(`metadata = ${meta})`);
      ctx.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, ...metaParams, taskId);
    } catch {
      // The file is the source of truth; the re-sync below catches up.
    }
  }

  let dbNote = null;
  try {
    const refresh = ctx.refreshTaskFile || defaultRefresh;
    const result = await refresh(ctx.db, { source, file });
    if (result && result.success === false) {
      dbNote = `The file was written, but re-reading it into the database failed (${result.message || result.error || 'unknown error'}); the next sync will catch up.`;
    }
  } catch (error) {
    dbNote = `The file was written, but re-reading it into the database failed (${error.message}); the next sync will catch up.`;
  }
  return { ok: true, taskId, dbNote };
}

function replyFor(located, newLine, writeResult, extra, lead) {
  const tz = getConfiguredTimezone();
  const value = {
    user_timezone: tz,
    task_id: writeResult.taskId,
    file: located.file,
    line_number: located.index + 1,
    ...(located.shifted ? { line_moved: true } : {}),
    old_line: located.lines[located.index],
    new_line: newLine,
    ...extra,
  };
  const notes = [
    located.shifted ? `The task had moved to line ${located.index + 1} since the last sync; its id is now ${writeResult.taskId}.` : null,
    writeResult.dbNote,
  ].filter(Boolean);
  return jsonResult(value, [lead, ...notes].join(' '));
}

const TASK_ID_PROP = { type: 'string', description: 'The task id from list_tasks or search_tasks' };
const TITLE_PROP = { type: 'string', description: 'The task\'s title, or a distinctive part of it (4+ characters), to confirm which task to change. Required; the change is refused if it doesn\'t match.' };

const postponeTask = {
  name: 'postpone_task',
  kind: 'write',
  pluginType: 'tasks',
  description: 'Postpone an open markdown task, like the web\'s ⏩ button. Without to_date, every scheduled (⏳) or due (📅) date that is today or earlier moves to tomorrow; if both are already in the future, the due date (else the scheduled date) moves out a day. With to_date, each of those dates earlier than to_date moves to it. Returns the rewritten line. The task must already have a scheduled or due date; use update_task to give it one.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: TASK_ID_PROP,
      title: TITLE_PROP,
      to_date: { type: 'string', description: 'Move the task to this day, YYYY-MM-DD, today or later (default: tomorrow in the configured time zone)' },
    },
    required: ['task_id', 'title'],
  },
  handler: async (args = {}, ctx = {}) => {
    const tz = getConfiguredTimezone();
    const today = getTodayDate(tz);
    let toDate = null;
    if (args.to_date !== undefined && args.to_date !== null && args.to_date !== '') {
      toDate = String(args.to_date).trim();
      if (!isCalendarDate(toDate)) return errorResult(`to_date "${args.to_date}" is not a date written YYYY-MM-DD. Nothing was changed.`);
      if (toDate < today) return errorResult(`to_date ${toDate} is before today (${today}). Nothing was changed.`);
    }

    const located = locateTask(ctx.db, args, { projectRoot: ctx.projectRoot, vaultPath: ctx.vaultPath || getAbsoluteVaultPath() });
    if (!located.ok) return errorResult(located.error);
    const line = located.lines[located.index];
    if (!isOpenTaskLine(line)) return errorResult('The task is not open, so there is nothing to postpone. Nothing was changed.');

    let result;
    if (toDate) {
      result = moveTaskLineTo(line, toDate);
      if (result.error) return errorResult(`${result.error}. Nothing was changed.`);
    } else {
      result = postponeTaskLine(line, today);
      if (!result) return errorResult('The task has no scheduled or due date to move; use update_task to give it one. Nothing was changed.');
    }

    const written = await writeTaskLine(ctx, located, result.line, {
      due_date: result.dueDate,
      scheduled_date: result.scheduledDate,
    });
    if (!written.ok) return errorResult(written.error);
    const dates = [result.scheduledDate && `scheduled ${result.scheduledDate}`, result.dueDate && `due ${result.dueDate}`].filter(Boolean).join(', ');
    return replyFor(located, result.line, written, {
      scheduled_date: result.scheduledDate,
      due_date: result.dueDate,
    }, `Postponed "${located.task.title}": now ${dates}.`);
  },
};

const updateTask = {
  name: 'update_task',
  kind: 'write',
  pluginType: 'tasks',
  description: 'Change a markdown task\'s title, due date, scheduled date, priority, stage or topics, like the web\'s task edit. Only the fields you send change; the rest of the line (recurrence, created date, other tags) stays. Send "none" to remove a date, the priority or the stage, and an empty topics list to remove the topics. Returns the rewritten line.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: TASK_ID_PROP,
      title: TITLE_PROP,
      new_title: { type: 'string', description: 'The new title, without dates, priority or tags' },
      due_date: { type: 'string', description: 'Due date (📅), YYYY-MM-DD, or "none" to remove it' },
      scheduled_date: { type: 'string', description: 'Scheduled date (⏳), YYYY-MM-DD, or "none" to remove it' },
      priority: { type: 'string', enum: [...TASK_PRIORITIES, 'none'], description: 'Priority, or "none" to remove it' },
      stage: { type: 'string', enum: [...TASK_STAGES, 'none'], description: 'Stage tag (#stage/...), or "none" to remove it' },
      topics: { type: 'array', items: { type: 'string' }, description: 'The task\'s topics (#topic/...), replacing the ones it has; [] removes them' },
    },
    required: ['task_id', 'title'],
  },
  handler: async (args = {}, ctx = {}) => {
    const valid = validateTaskChanges(args);
    if (valid.error) return errorResult(valid.error);
    const { changes } = valid;

    const located = locateTask(ctx.db, args, { projectRoot: ctx.projectRoot, vaultPath: ctx.vaultPath || getAbsoluteVaultPath() });
    if (!located.ok) return errorResult(located.error);
    const line = located.lines[located.index];

    let newLine;
    try {
      newLine = updateTaskLine(line, changes);
    } catch (error) {
      return errorResult(error.message);
    }
    if (newLine === null) return errorResult('That line is not a task. Nothing was changed.');
    if (newLine === line) {
      return jsonResult({ user_timezone: getConfiguredTimezone(), task_id: located.task.id, line, changed: false }, 'The task already reads that way; nothing was changed.');
    }

    const dates = taskDatesOf(newLine);
    const dbFields = {};
    if (changes.title !== undefined) dbFields.title = taskTitleOf(newLine);
    if (changes.priority !== undefined) dbFields.priority = changes.priority;
    if (changes.due_date !== undefined) dbFields.due_date = dates.due;
    if (changes.scheduled_date !== undefined) dbFields.scheduled_date = dates.scheduled;
    if (changes.stage !== undefined) dbFields.stage = changes.stage;
    if (changes.topics !== undefined) dbFields.topics = changes.topics;

    const written = await writeTaskLine(ctx, located, newLine, dbFields);
    if (!written.ok) return errorResult(written.error);
    const changed = Object.keys(changes).map(k => (k === 'title' ? 'title' : k.replace('_', ' '))).join(', ');
    return replyFor(located, newLine, written, { changed: Object.keys(changes) }, `Updated ${changed} of "${located.task.title}".`);
  },
};

export const tools = [postponeTask, updateTask];
