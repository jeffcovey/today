/**
 * Safeguards for MCP tools that change data (issue #686).
 *
 * Every tool has a kind:
 *   - 'read':        changes nothing.
 *   - 'write':       a vault write that is easy to undo (add or complete a
 *                    task, start a timer, add a diary entry). Hidden and
 *                    refused when `[mcp] read_only = true`.
 *   - 'destructive': deletes or moves data, rewrites in bulk, or writes to an
 *                    outside service (calendar update/delete, YNAB). Hidden
 *                    and refused unless `[mcp] allow_destructive = true`, and
 *                    always refused on a read-only connection.
 *
 * Tools that take a task, event or contact ID also require the item's
 * title and refuse when it doesn't match (`verifyTitle`). Batch tools take
 * `dry_run`, on by default. Every write and destructive call is appended to
 * a log in the vault (`logWrite`), so a change made from a phone can be
 * found and undone.
 */

import fs from 'fs';
import path from 'path';
import { getConfig, getAbsoluteVaultPath } from './config.js';
import { getConfiguredTimezone, getTodayDate } from './date-utils.js';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

export const TOOL_KINDS = new Set(['read', 'write', 'destructive']);
export const DEFAULT_WRITE_LOG_DIR = 'logs/mcp-writes';

/** The [mcp] settings that gate tools, read fresh each time. */
export function getMcpPolicy({ readOnly = false, raw } = {}) {
  let section = raw;
  if (section === undefined) {
    try {
      section = getConfig('mcp');
    } catch {
      section = undefined;
    }
  }
  section = section && typeof section === 'object' ? section : {};
  return {
    readOnly: readOnly || section.read_only === true,
    allowDestructive: section.allow_destructive === true,
    writeLogDir: typeof section.write_log === 'string'
      ? section.write_log
      : (section.write_log === false ? null : DEFAULT_WRITE_LOG_DIR),
  };
}

/** Whether a tool of this kind may be listed and called under `policy`. */
export function isKindAllowed(kind, policy) {
  if (kind === 'read') return true;
  if (policy.readOnly) return false;
  if (kind === 'destructive') return policy.allowDestructive;
  return kind === 'write';
}

/** Why a kind is refused, for the error a caller sees. */
export function refusalReason(name, kind, policy) {
  if (policy.readOnly) return `${name} is not available on this read-only connection`;
  if (kind === 'destructive' && !policy.allowDestructive) {
    return `${name} changes or deletes data outside the vault, and is off unless [mcp] allow_destructive = true is set in the config`;
  }
  return `${name} is not available`;
}

function normalizeTitle(text) {
  return String(text ?? '')
    .toLowerCase()
    // Obsidian Tasks markers: checkbox, dates, priority and recurrence emoji.
    .replace(/^\s*(?:>\s*)*-\s*\[[ xX-]\]\s*/, '')
    .replace(/[📅⏳🛫➕✅❌🔁⏫🔼🔽⏬🔺]️?\s*\S*/gu, ' ')
    .replace(/[*_`~[\]()#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check that the title a caller gave matches the item it is about to change.
 * Case, Markdown and Obsidian Tasks date markers are ignored; the caller's
 * title may be the whole title or a distinctive part of it (at least 4
 * characters), so "Call Donald" matches "Call Donald Schmoll 🔁 every week".
 *
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function verifyTitle(given, actual, { what = 'item' } = {}) {
  const g = normalizeTitle(given);
  const a = normalizeTitle(actual);
  if (!g) return { ok: false, error: `title is required to confirm which ${what} to change` };
  if (!a) return { ok: false, error: `Could not read the ${what}'s title to confirm it` };
  if (a === g || (g.length >= 4 && a.includes(g))) return { ok: true };
  return { ok: false, error: `Title mismatch: the ${what} is "${String(actual).trim()}", not "${String(given).trim()}". Nothing was changed.` };
}

/** dry_run for batch tools: on unless the caller sends false. */
export function isDryRun(args) {
  return args?.dry_run !== false;
}

function summarizeArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (typeof value === 'string' && value.length > 300) out[key] = `${value.slice(0, 300)}…`;
    else out[key] = value;
  }
  return out;
}

function resultSummary(result) {
  const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

/**
 * Append one line per write to `<vault>/<write_log>/YYYY-MM-DD.md`.
 * Best effort: a failure to log never fails the tool.
 *
 * @returns {string|null} The file written, or null.
 */
export function logWrite({ tool, kind, args, result, policy, vaultPath, now = new Date() }) {
  const dir = policy?.writeLogDir;
  if (!dir) return null;
  try {
    const tz = getConfiguredTimezone();
    const day = getTodayDate(tz);
    const time = format(new TZDate(now.getTime(), tz), 'HH:mm:ssxxx');
    const root = vaultPath || getAbsoluteVaultPath();
    const folder = path.isAbsolute(dir) ? dir : path.join(root, dir);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${day}.md`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# MCP writes, ${day}\n\nChanges made through Today's MCP server.\n\n`);
    }
    const outcome = result?.isError ? 'refused or failed' : 'ok';
    const line = `- ${time} \`${tool}\` (${kind}) ${outcome}: ${resultSummary(result)}\n` +
      `  - args: \`${JSON.stringify(summarizeArgs(args)).replace(/`/g, "'")}\`\n`;
    fs.appendFileSync(file, line);
    return file;
  } catch {
    return null;
  }
}

/** Small reply helpers shared by tool modules. */
export function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(value, lead = null) {
  const content = [];
  if (lead) content.push({ type: 'text', text: lead });
  content.push({ type: 'text', text: JSON.stringify(value, null, 2) });
  return { content };
}

export function errorResult(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
