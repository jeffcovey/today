/**
 * Durable ROLE sections in diary files.
 *
 * Role agents report into the day's diary inside marker blocks:
 *
 *   <!-- ROLE:cpa:START -->
 *   ## 🤖 CPA
 *
 *   ### 14:05
 *
 *   **Status:** OK
 *
 *   Categorized 12 transactions.
 *   <!-- ROLE:cpa:END -->
 *
 * Unlike the TODAY: marker namespace (ephemeral, stripped from past days
 * by the markdown-diary plugin), ROLE: blocks are the permanent record:
 * they are never cleaned up, they count as real diary content, and the
 * plugin parses them into the diary table. Content inside a block is
 * append-only — new entries are inserted before the END marker and
 * existing lines (including user replies) are never rewritten.
 */

import fs from 'fs';
import path from 'path';
import { writeFileAtomicCAS } from './fs-atomic.js';

export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_REPORT_LENGTH = 2000;
export const MAX_ROLE_TITLE_LENGTH = 80;
export const ROLE_STATUSES = ['ok', 'blocked', 'needs-attention', 'quiet'];

const CAS_RETRIES = 3;
const LOCK_RETRIES = 20;
const LOCK_RETRY_DELAY_MS = 50;
const STALE_LOCK_TIMEOUT_MS = 10_000;

export function roleStartMarker(role) {
  return `<!-- ROLE:${role}:START -->`;
}

export function roleEndMarker(role) {
  return `<!-- ROLE:${role}:END -->`;
}

/**
 * Extract ROLE blocks from a diary body.
 * Returns { blocks: [{ role, content }], remainder } where remainder is the
 * body with all ROLE blocks removed, so section parsers never attribute
 * role content to an adjacent ## section.
 */
export function extractRoleBlocks(body) {
  const blocks = [];
  const blockRe = /<!-- ROLE:([a-z0-9-]+):START -->\n?([\s\S]*?)<!-- ROLE:\1:END -->\n?/g;

  const remainder = body.replace(blockRe, (match, role, content) => {
    blocks.push({ role, content: stripRoleHeading(content).trim() });
    return '';
  });

  return { blocks, remainder };
}

/** Drop the block's display heading (e.g. "## 🤖 CPA") so it isn't parsed as entry text. */
function stripRoleHeading(content) {
  return content.replace(/^\s*## [^\n]*\n/, '');
}

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

function defaultTitle(role) {
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
  const tz = process.env.TZ || 'America/New_York';
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
      const date = fileDate || new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });
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
