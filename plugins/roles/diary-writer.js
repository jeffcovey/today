/**
 * Writes role-agent reports into the day's diary, inside the durable ROLE
 * marker blocks defined in src/diary-role-blocks.js. Used by report.js, the
 * only way roles write to the diary.
 *
 * Content inside a block is append-only: new entries are inserted before the
 * END marker, and existing lines (including the user's replies) are never
 * rewritten. The one exception is setRoleCheckboxState, which flips a single
 * checkbox's state character.
 */

import fs from 'fs';
import path from 'path';
import { writeFileAtomicCAS } from '../../src/fs-atomic.js';
import { ROLE_NAME_RE, roleStartMarker, roleEndMarker } from '../../src/diary-role-blocks.js';
import { getFullConfig, getTimezone } from '../../src/config.js';

export const MAX_REPORT_LENGTH = 2000;
export const MAX_REPLY_LENGTH = 4000;
export const MAX_ROLE_TITLE_LENGTH = 80;
export const ROLE_STATUSES = ['ok', 'blocked', 'needs-attention', 'quiet'];

const CAS_RETRIES = 3;
const LOCK_RETRIES = 20;
const LOCK_RETRY_DELAY_MS = 50;
const STALE_LOCK_TIMEOUT_MS = 10_000;

/**
 * Validate a role report before writing. Returns an array of error strings
 * (empty when valid).
 */
export function validateRoleReport(role, text, { status, title } = {}) {
  const errors = [];

  if (!ROLE_NAME_RE.test(role || '')) {
    errors.push(`Invalid role name "${role}": use lowercase letters, digits, and hyphens (max 32 chars)`);
  }

  const body = (text || '').trim();
  if (!body) {
    errors.push('Report text is empty');
  }
  if (body.length > MAX_REPORT_LENGTH) {
    errors.push(`Report is ${body.length} chars; the limit is ${MAX_REPORT_LENGTH}`);
  }
  // A marker inside a report would corrupt the block structure of the file.
  if (/<!--\s*(ROLE|TODAY):/i.test(body)) {
    errors.push('Report text may not contain ROLE: or TODAY: markers');
  }

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      errors.push('Title must be a non-empty single line');
    } else {
      if (/[\r\n\u2028\u2029]/.test(title)) {
        errors.push('Title must be a non-empty single line');
      }
      if (title.length > MAX_ROLE_TITLE_LENGTH) {
        errors.push(`Title exceeds ${MAX_ROLE_TITLE_LENGTH} characters`);
      }
      if (/<!--|--!?>|(?:ROLE|TODAY)\s*:/i.test(title)) {
        errors.push('Title may not contain comments or ROLE:/TODAY: markers');
      }
    }
  }

  if (status !== undefined && !ROLE_STATUSES.includes(status)) {
    errors.push(`Invalid status "${status}": expected one of ${ROLE_STATUSES.join(', ')}`);
  }

  return errors;
}

/**
 * True when any [plugins.roles.<source>] is enabled. Role writes (reports
 * from agents, replies from the web) are refused otherwise.
 */
export function rolesPluginEnabled() {
  const sources = getFullConfig().plugins?.roles || {};
  return Object.values(sources).some(source => source && source.enabled);
}

export function defaultTitle(role) {
  return role
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function statusLabel(status) {
  const labels = {
    ok: 'OK',
    blocked: 'Blocked',
    'needs-attention': 'Needs attention',
    quiet: 'Quiet'
  };
  return labels[status] || status;
}

export function formatRoleEntry(text, { time, status } = {}) {
  const lines = [`### ${time}`, ''];
  if (status) {
    lines.push(`**Status:** ${statusLabel(status)}`, '');
  }
  lines.push(text.trim(), '');
  return lines.join('\n');
}

function localTime(date = new Date()) {
  const tz = process.env.TZ || getTimezone();
  return date.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

function acquireDiaryLock(lockPath) {
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}`);
      const stat = fs.fstatSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      return stat;
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // The descriptor may already be closed.
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // The lock may already have been removed.
        }
      }
      if (error.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
          const current = fs.statSync(lockPath);
          if (current.dev === stat.dev && current.ino === stat.ino) {
            fs.unlinkSync(lockPath);
            continue;
          }
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }

      if (attempt < LOCK_RETRIES) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`Timed out acquiring diary lock ${lockPath}`);
}

export const CHECKBOX_STATES = ['x', '-'];

/**
 * Flip one checkbox inside a role's own block: `- [ ]` becomes `- [x]`
 * (done) or `- [-]` (cancelled). This is the only mutation allowed on
 * existing block content — a single state-character substitution. The
 * match must identify exactly one unchecked checkbox line inside the
 * block; anything else is an error and the file is left untouched, so
 * prose (and user replies) stay append-only.
 *
 * Returns { ok, line } with the updated line, or { ok: false, error }.
 */
export function setRoleCheckboxState(filePath, role, match, state) {
  if (!ROLE_NAME_RE.test(role || '')) {
    return { ok: false, error: `Invalid role name "${role}": use lowercase letters, digits, and hyphens (max 32 chars)` };
  }
  const needle = (match || '').trim();
  if (!needle) {
    return { ok: false, error: 'Checkbox match text is empty' };
  }
  if (!CHECKBOX_STATES.includes(state)) {
    return { ok: false, error: `Invalid checkbox state "${state}": expected one of ${CHECKBOX_STATES.join(', ')}` };
  }

  const startMarker = roleStartMarker(role);
  const endMarker = roleEndMarker(role);
  const lockPath = `${filePath}.lock`;

  let lockStat;
  try {
    lockStat = acquireDiaryLock(lockPath);
    try {
      for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
        let original;
        try {
          original = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') {
            return { ok: false, error: `Diary file ${filePath} does not exist` };
          }
          throw error;
        }

        const startIndex = original.indexOf(startMarker);
        const endIndex = original.indexOf(endMarker);
        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
          return { ok: false, error: `No ${role} block in ${filePath}` };
        }

        const blockStart = startIndex + startMarker.length;
        const block = original.slice(blockStart, endIndex);
        const lines = block.split('\n');
        const haystackNeedle = needle.toLowerCase();

        const openMatches = [];
        let settledMatches = 0;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(haystackNeedle)) {
            continue;
          }
          if (/^\s*- \[ \] /.test(lines[i])) {
            openMatches.push(i);
          } else if (/^\s*- \[[^ ]\] /.test(lines[i])) {
            settledMatches++;
          }
        }

        if (openMatches.length === 0) {
          return settledMatches > 0
            ? { ok: false, error: `The checkbox matching "${needle}" in the ${role} block is already checked or cancelled` }
            : { ok: false, error: `No open checkbox matching "${needle}" in the ${role} block` };
        }
        if (openMatches.length > 1) {
          return { ok: false, error: `"${needle}" matches ${openMatches.length} open checkboxes in the ${role} block; use more specific text` };
        }

        lines[openMatches[0]] = lines[openMatches[0]].replace('- [ ] ', `- [${state}] `);
        const updated = original.slice(0, blockStart) + lines.join('\n') + original.slice(endIndex);

        const { conflict } = writeFileAtomicCAS(filePath, updated, original);
        if (!conflict) {
          return { ok: true, line: lines[openMatches[0]].trim() };
        }
      }

      return { ok: false, error: `Concurrent writes kept changing ${filePath}; checkbox not flipped` };
    } finally {
      releaseDiaryLock(lockPath, lockStat);
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const ENTRY_HEADING_RE = /^### (\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/;
const REPLY_LINE_RE = /^\s*(?:->|→)\s*[a-z0-9][a-z0-9-]*\s*:/;
const STATUS_LINE_RE = /^\*\*Status:\*\*\s*(.+?)\s*$/;
const CHECKBOX_RE = /^(\s*- \[)([ x-])(\] .*\r?)$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`+|~+)[ \t]*$/;

function linesInsideFences(lines) {
  let fence = null;
  return lines.map((line) => {
    const fenceLine = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    let insideFence = Boolean(fence);
    if (fence) {
      const closingFence = fenceLine.match(FENCE_CLOSE_RE);
      if (closingFence && closingFence[1][0] === fence.character && closingFence[1].length >= fence.length) {
        fence = null;
      }
    } else {
      const openingFence = fenceLine.match(FENCE_OPEN_RE);
      if (openingFence && !(openingFence[1][0] === '`' && openingFence[2].includes('`'))) {
        fence = { character: openingFence[1][0], length: openingFence[1].length };
        insideFence = true;
      }
    }
    return insideFence;
  });
}

function normalizeTime(time) {
  const match = (time || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }
  return `${match[1].padStart(2, '0')}:${match[2]}${match[3] ? `:${match[3]}` : ''}`;
}

function headingTime(line) {
  const match = line.match(ENTRY_HEADING_RE);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}${match[3] ? `:${match[3]}` : ''}` : null;
}

function statusKeyFromLabel(label) {
  return ROLE_STATUSES.find((key) => statusLabel(key) === label) || null;
}

function localDate(date = new Date()) {
  const tz = process.env.TZ || getTimezone();
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Replace the text of one of the role's own earlier entries (`### HH:MM`)
 * in place, so an outdated headline or a wrong fact stops being repeated.
 *
 * What the user wrote survives: reply paragraphs inside the entry are kept
 * verbatim, after the new text, and a checkbox the user ticked or that was
 * cancelled keeps its state when the new text repeats the item. The entry
 * is stamped "*Amended <date> <time>.*" so the record shows it changed.
 * Without `status`, the entry's existing status line is kept.
 *
 * Returns { ok, line, replies, settled } or { ok: false, error }.
 */
export function amendRoleEntry(filePath, role, time, text, { status, amendedAt } = {}) {
  const errors = validateRoleReport(role, text, { status });
  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') };
  }
  const wantedTime = normalizeTime(time);
  if (!wantedTime) {
    return { ok: false, error: `Invalid entry time "${time}": expected HH:MM` };
  }

  const startMarker = roleStartMarker(role);
  const endMarker = roleEndMarker(role);
  const lockPath = `${filePath}.lock`;

  let lockStat;
  try {
    lockStat = acquireDiaryLock(lockPath);
    try {
      for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
        let original;
        try {
          original = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') {
            return { ok: false, error: `Diary file ${filePath} does not exist` };
          }
          throw error;
        }

        const startIndex = original.indexOf(startMarker);
        const endIndex = original.indexOf(endMarker);
        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
          return { ok: false, error: `No ${role} block in ${filePath}` };
        }

        const blockStart = startIndex + startMarker.length;
        const lines = original.slice(blockStart, endIndex).split('\n');
        const insideFences = linesInsideFences(lines);
        const headings = lines
          .map((line, index) => ({ index, time: insideFences[index] ? null : headingTime(line) }))
          .filter((h) => h.time !== null);
        const matches = headings.filter((h) => h.time === wantedTime);
        if (matches.length === 0) {
          return { ok: false, error: `No ${wantedTime} entry in the ${role} block of ${filePath}` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `${matches.length} entries at ${wantedTime} in the ${role} block; cannot tell which to amend` };
        }

        const from = matches[0].index;
        const next = headings.find((h) => h.index > from);
        const to = next ? next.index : lines.length;
        const region = lines.slice(from + 1, to);

        const regionInsideFences = insideFences.slice(from + 1, to);
        const firstReply = region.findIndex((line, index) => !regionInsideFences[index] && REPLY_LINE_RE.test(line));
        const old = firstReply === -1 ? region : region.slice(0, firstReply);
        const replies = firstReply === -1 ? [] : region.slice(firstReply);
        while (replies.length > 0 && replies[replies.length - 1].trim() === '') {
          replies.pop();
        }

        let statusKey = status;
        if (!statusKey) {
          const oldStatus = old.map((line) => line.match(STATUS_LINE_RE)).find(Boolean);
          statusKey = oldStatus ? statusKeyFromLabel(oldStatus[1]) : undefined;
        }

        const settledStates = new Map();
        for (const line of old) {
          const box = line.match(CHECKBOX_RE);
          if (box && box[2] !== ' ') {
            settledStates.set(box[3].trim().toLowerCase(), box[2]);
          }
        }
        let settled = 0;
        const body = text.trim().split('\n').map((line) => {
          const box = line.match(CHECKBOX_RE);
          if (!box) {
            return line;
          }
          const state = settledStates.get(box[3].trim().toLowerCase());
          if (!state) {
            return line;
          }
          settled++;
          return `${box[1]}${state}${box[3]}`;
        });

        const stamp = amendedAt || `${localDate()} ${localTime()}`;
        const entry = [lines[from], ''];
        if (statusKey) {
          entry.push(`**Status:** ${statusLabel(statusKey)}`, '');
        }
        entry.push(`*Amended ${stamp}.*`, '', ...body, '');
        if (replies.length > 0) {
          entry.push(...replies, '');
        }

        const updatedLines = [...lines.slice(0, from), ...entry, ...lines.slice(to)];
        const updated = original.slice(0, blockStart) + updatedLines.join('\n') + original.slice(endIndex);

        const { conflict } = writeFileAtomicCAS(filePath, updated, original);
        if (!conflict) {
          return {
            ok: true,
            line: lines[from].trim(),
            replies: replies.filter((line, index) => !regionInsideFences[firstReply + index] && REPLY_LINE_RE.test(line)).length,
            settled
          };
        }
      }

      return { ok: false, error: `Concurrent writes kept changing ${filePath}; entry not amended` };
    } finally {
      releaseDiaryLock(lockPath, lockStat);
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function releaseDiaryLock(lockPath, lockStat) {
  try {
    const current = fs.statSync(lockPath);
    if (current.dev === lockStat.dev && current.ino === lockStat.ino) {
      fs.unlinkSync(lockPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

// A first line that opens a block (list, heading, quote, fence, table)
// would be swallowed into the "-> role:" paragraph, so it starts on the
// next line instead.
const BLOCK_START_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~|\|)/;

/**
 * Format the user's reply to a role. The text is kept as typed (lists,
 * paragraphs, and all); only the "-> role:" prefix is added.
 */
export function formatRoleReply(role, text) {
  const body = (text || '').replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').trimEnd();
  return BLOCK_START_RE.test(body) ? `-> ${role}:\n${body}` : `-> ${role}: ${body.trimStart()}`;
}

/**
 * Append the user's reply as the last item in a role's block, just before
 * its END marker. The block must already exist: a reply answers a role
 * that has reported. Uses the same lock and compare-and-swap as role
 * reports, so a reply and an agent's report can't overwrite each other.
 *
 * Returns { ok, reply } or { ok: false, error, code } where code is
 * 'invalid', 'missing', or 'conflict'.
 */
export function appendRoleReply(filePath, role, text) {
  if (!ROLE_NAME_RE.test(role || '')) {
    return { ok: false, code: 'invalid', error: `Invalid role name "${role}"` };
  }
  const body = (text || '').trim();
  if (!body) {
    return { ok: false, code: 'invalid', error: 'Reply is empty' };
  }
  if (body.length > MAX_REPLY_LENGTH) {
    return { ok: false, code: 'invalid', error: `Reply is ${body.length} characters; the limit is ${MAX_REPLY_LENGTH}` };
  }
  if (/<!--\s*(ROLE|TODAY):/i.test(body)) {
    return { ok: false, code: 'invalid', error: 'Reply may not contain ROLE: or TODAY: markers' };
  }

  const reply = formatRoleReply(role, text);
  const startMarker = roleStartMarker(role);
  const endMarker = roleEndMarker(role);
  const lockPath = `${filePath}.lock`;

  let lockStat;
  try {
    lockStat = acquireDiaryLock(lockPath);
    try {
      for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
        let original;
        try {
          original = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') {
            return { ok: false, code: 'missing', error: `Diary file ${filePath} does not exist` };
          }
          throw error;
        }

        const startIndex = original.indexOf(startMarker);
        const endIndex = original.indexOf(endMarker);
        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
          return { ok: false, code: 'missing', error: `No ${role} block in ${filePath}` };
        }

        const before = original.slice(0, endIndex).replace(/\n*$/, '\n\n');
        const updated = `${before}${reply}\n\n${original.slice(endIndex)}`;

        const { conflict } = writeFileAtomicCAS(filePath, updated, original);
        if (!conflict) {
          return { ok: true, reply };
        }
      }

      return { ok: false, code: 'conflict', error: `Concurrent writes kept changing ${filePath}; reply not saved` };
    } finally {
      try {
        const current = fs.statSync(lockPath);
        if (current.dev === lockStat.dev && current.ino === lockStat.ino) {
          fs.unlinkSync(lockPath);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Append a role report to a diary file. Creates the file (with minimal
 * front matter) and the role's block when missing; otherwise inserts the
 * new entry just before the block's END marker, leaving existing content
 * untouched.
 *
 * Returns { ok, createdFile, createdBlock, error }.
 */
export function appendRoleReport(filePath, role, text, { time, status, title, fileDate } = {}) {
  const errors = validateRoleReport(role, text, { status, title });
  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') };
  }

  const entry = formatRoleEntry(text, { time: time || localTime(), status });
  const startMarker = roleStartMarker(role);
  const endMarker = roleEndMarker(role);
  const lockPath = `${filePath}.lock`;

  let createdFile = false;
  let lockStat;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    lockStat = acquireDiaryLock(lockPath);
    try {
      const date = fileDate || new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || getTimezone() });
      const initialContent = `---\ndate: ${date}\ncssclasses: dashboard\nobsidianUIMode: preview\n---\n\n`;

      for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
        let original;
        try {
          original = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
          const { conflict, written } = writeFileAtomicCAS(filePath, initialContent, null);
          if (conflict) {
            continue;
          }
          createdFile = written;
          original = initialContent;
        }

        let updated;
        let createdBlock = false;
        const endIndex = original.indexOf(endMarker);
        if (original.includes(startMarker) && endIndex !== -1) {
          const before = original.slice(0, endIndex).replace(/\n*$/, '\n\n');
          updated = before + entry + original.slice(endIndex);
        } else {
          const block = `${startMarker}\n## 🤖 ${title ? title.trim() : defaultTitle(role)}\n\n${entry}${endMarker}\n`;
          updated = original.replace(/\n*$/, '\n\n') + block;
          createdBlock = true;
        }

        const { conflict } = writeFileAtomicCAS(filePath, updated, original);
        if (!conflict) {
          return { ok: true, createdFile, createdBlock };
        }
      }

      return { ok: false, error: `Concurrent writes kept changing ${filePath}; report not written` };
    } finally {
      try {
        const current = fs.statSync(lockPath);
        if (current.dev === lockStat.dev && current.ino === lockStat.ino) {
          fs.unlinkSync(lockPath);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
