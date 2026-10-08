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
import { writeFileAtomic, writeFileAtomicCAS } from './fs-atomic.js';

export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_REPORT_LENGTH = 2000;
export const ROLE_STATUSES = ['ok', 'blocked', 'needs-attention', 'quiet'];

const CAS_RETRIES = 3;

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
export function validateRoleReport(role, text, { status } = {}) {
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

/**
 * Append a role report to a diary file. Creates the file (with minimal
 * front matter) and the role's block when missing; otherwise inserts the
 * new entry just before the block's END marker, leaving existing content
 * untouched.
 *
 * Returns { ok, createdFile, createdBlock, error }.
 */
export function appendRoleReport(filePath, role, text, { time, status, title, fileDate } = {}) {
  const errors = validateRoleReport(role, text, { status });
  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') };
  }

  const entry = formatRoleEntry(text, { time: time || localTime(), status });
  const startMarker = roleStartMarker(role);
  const endMarker = roleEndMarker(role);

  let createdFile = false;
  if (!fs.existsSync(filePath)) {
    const date = fileDate || new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });
    writeFileAtomic(filePath, `---\ndate: ${date}\ncssclasses: dashboard\nobsidianUIMode: preview\n---\n\n`);
    createdFile = true;
  }

  for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated;
    let createdBlock = false;

    const endIndex = original.indexOf(endMarker);
    if (original.includes(startMarker) && endIndex !== -1) {
      // Append inside the existing block, just before the END marker.
      const before = original.slice(0, endIndex).replace(/\n*$/, '\n\n');
      updated = before + entry + original.slice(endIndex);
    } else {
      // New block at the end of the file, where the day reads chronologically.
      const block = `${startMarker}\n## 🤖 ${title || defaultTitle(role)}\n\n${entry}${endMarker}\n`;
      updated = original.replace(/\n*$/, '\n\n') + block;
      createdBlock = true;
    }

    const { conflict } = writeFileAtomicCAS(filePath, updated, original);
    if (!conflict) {
      return { ok: true, createdFile, createdBlock };
    }
  }

  return { ok: false, error: `Concurrent writes kept changing ${filePath}; report not written` };
}
