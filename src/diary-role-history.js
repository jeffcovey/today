/**
 * A role's recent past in the diary: its own ROLE blocks and the chief of
 * staff's, with the user's reply lines inside them, read straight from the
 * diary files (the vault is the record; the database is a cache).
 */

import fs from 'fs';
import path from 'path';
import { extractRoleBlocks } from './diary-role-blocks.js';

const REPLY_RE = /^\s*(?:->|→)\s*[a-z0-9][a-z0-9-]*\s*:/;

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Collect the blocks of the given roles from the diary files of the last
 * `days` days ending at `today`. Oldest first, file order within a day.
 * Returns [{ date, role, content }].
 */
export function collectRoleHistory({ diaryDir, roles, days = 14, today }) {
  const wanted = new Set(roles);
  const history = [];

  for (let offset = days - 1; offset >= 0; offset--) {
    const date = shiftDate(today, -offset);
    const file = path.join(diaryDir, `${date}.md`);
    if (!fs.existsSync(file)) {
      continue;
    }
    const { blocks } = extractRoleBlocks(fs.readFileSync(file, 'utf8'));
    for (const block of blocks) {
      if (wanted.has(block.role)) {
        history.push({ date, role: block.role, content: block.content });
      }
    }
  }

  return history;
}

export function countUserReplies(history) {
  return history.reduce((count, item) => {
    return count + item.content.split('\n').filter((line) => REPLY_RE.test(line)).length;
  }, 0);
}

/**
 * Plain-text rendering for the CLI and for role agents: a header that
 * states the precedence rule, then every block verbatim, oldest first.
 */
export function formatRoleHistory(history, { role, chief, days, today }) {
  const from = shiftDate(today, -(days - 1));
  const withChief = chief && chief !== role;
  const out = [
    `Diary blocks for ${withChief ? `${role} and ${chief}` : role}, ${from} to ${today} (${days} days), oldest first.`,
    withChief
      ? `Precedence: the user's "->" reply lines, then ${chief}, then ${role}; within a level the later statement wins.`
      : `Precedence: the user's "->" reply lines, then ${role}; within a level the later statement wins.`,
    ''
  ];

  if (history.length === 0) {
    out.push('(no blocks in this period)');
    return out.join('\n');
  }

  for (const item of history) {
    out.push(`## ${item.date} — ${item.role}`, '', item.content, '');
  }

  out.push(`${history.length} blocks, ${countUserReplies(history)} reply lines from the user.`);
  return out.join('\n');
}
