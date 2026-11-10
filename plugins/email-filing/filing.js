// Email filing: the decisions, kept apart from IMAP so they can be tested.
//
// Two pieces of state, neither in the database:
// - sender rules, in a TOML file in the vault (see parseRules/serializeRules);
// - where the plugin last saw each message, as an IMAP keyword on the message
//   itself (see folderKeyword). The keyword moves with the message, so a
//   message whose keyword does not match its folder was moved by the user.

import crypto from 'crypto';
import { parse as parseToml } from 'smol-toml';

export const INBOX = 'INBOX';
export const KEYWORD_PREFIX = '$TodayIn_';

const SOURCES = new Set(['ai', 'learned', 'manual']);

export function folderKeyword(folderName) {
  const key = folderName.toUpperCase() === INBOX ? INBOX : folderName;
  return KEYWORD_PREFIX + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

export function isFilingKeyword(flag) {
  return typeof flag === 'string' && flag.startsWith(KEYWORD_PREFIX);
}

export function normalizeAddress(address) {
  return String(address || '').trim().toLowerCase();
}

/**
 * The configured folders as [{ name, description }], skipping INBOX and blanks.
 */
export function parseFolders(folders) {
  if (!folders || typeof folders !== 'object' || Array.isArray(folders)) return [];
  return Object.entries(folders)
    .map(([name, description]) => ({ name: String(name).trim(), description: String(description ?? '').trim() }))
    .filter(f => f.name && f.name.toUpperCase() !== INBOX);
}

// ── Rules file ──────────────────────────────────────────────────────────────

/**
 * Parse the rules file. Returns { sourceName: { sender: { folder, source } } }.
 * A hand-written entry may be just a folder name; it counts as "manual".
 */
export function parseRules(text) {
  if (!text || !text.trim()) return {};
  const data = parseToml(text);
  const rules = {};
  for (const [sourceName, section] of Object.entries(data)) {
    const senders = section?.senders;
    if (!senders || typeof senders !== 'object') continue;
    rules[sourceName] = {};
    for (const [sender, value] of Object.entries(senders)) {
      const rule = typeof value === 'string' ? { folder: value } : value;
      if (!rule || typeof rule.folder !== 'string' || !rule.folder.trim()) continue;
      const source = SOURCES.has(rule.source) ? rule.source : 'manual';
      rules[sourceName][normalizeAddress(sender)] = { folder: rule.folder.trim(), source };
    }
  }
  return rules;
}

const tomlString = (s) => JSON.stringify(String(s));

export const RULES_HEADER = `# Email filing rules, written by the email-filing plugin.
#
# One section per email-filing source. Each sender maps to a folder named in
# that source's config, or to "INBOX" to keep its mail in the inbox. A key may
# be an address (news@example.com) or a domain (example.com), which also
# covers its subdomains. An address rule wins over a domain rule.
#
# source = "learned"  taught by moving a message by hand
# source = "ai"       decided by the AI; replaced whenever you move one
# source = "manual"   written here by hand (the default when source is left out)
#
# Edit freely; comments other than this header are not kept.
`;

export function serializeRules(rules) {
  const out = [RULES_HEADER];
  for (const sourceName of Object.keys(rules).sort()) {
    const senders = rules[sourceName];
    const keys = Object.keys(senders).sort();
    if (keys.length === 0) continue;
    out.push(`\n[${tomlString(sourceName)}.senders]`);
    for (const sender of keys) {
      const { folder, source } = senders[sender];
      out.push(`${tomlString(sender)} = { folder = ${tomlString(folder)}, source = ${tomlString(source)} }`);
    }
  }
  return out.join('\n') + '\n';
}

/**
 * The rule for a sender: the address, then its domain and each parent domain.
 * A rule naming a folder that is no longer configured is ignored.
 */
export function lookupRule(senders, address, folderNames) {
  if (!senders) return null;
  const valid = (rule) => rule && (rule.folder.toUpperCase() === INBOX || folderNames.includes(rule.folder));
  const addr = normalizeAddress(address);
  if (valid(senders[addr])) return senders[addr];
  const domain = addr.split('@')[1];
  if (!domain) return null;
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const rule = senders[parts.slice(i).join('.')];
    if (valid(rule)) return rule;
  }
  return null;
}

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Messages the user moved into a filing folder: those lacking the folder's
 * keyword. Each teaches a rule for its sender. Applied oldest first, so the
 * most recent move wins when one sender turns up in several folders.
 *
 * @param {Array<{folder, uid, address, date, flags}>} candidates
 * @returns {Array<{address, folder}>}
 */
export function learnFromFolders(candidates) {
  return [...candidates]
    .filter(m => m.address && !(m.flags || []).includes(folderKeyword(m.folder)))
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(m => ({ address: normalizeAddress(m.address), folder: m.folder }));
}

/**
 * Decide what to do with each inbox message.
 *
 * Returns { moves, movedBack, unknown }:
 * - moves:     [{ uid, address, folder, flags }] to file by an existing rule
 * - movedBack: [{ uid, address, staleKeywords }] filed earlier, moved back by the user
 * - unknown:   messages with no rule, for the AI
 */
export function planInbox(messages, senders, folderNames, { keywordsSupported = true } = {}) {
  const moves = [];
  const movedBack = [];
  const unknown = [];
  const inboxKeyword = folderKeyword(INBOX);

  for (const m of messages) {
    if (!m.address) continue;
    const flags = m.flags || [];
    if (flags.includes('\\Deleted')) continue;

    if (keywordsSupported) {
      const stale = flags.filter(f => isFilingKeyword(f) && f !== inboxKeyword);
      if (stale.length > 0) {
        movedBack.push({ uid: m.uid, address: normalizeAddress(m.address), staleKeywords: stale });
        continue;
      }
    }

    const rule = lookupRule(senders, m.address, folderNames);
    if (!rule) unknown.push(m);
    else if (rule.folder.toUpperCase() !== INBOX) moves.push({ uid: m.uid, address: normalizeAddress(m.address), folder: rule.folder, flags });
  }
  return { moves, movedBack, unknown };
}

/**
 * Record a rule. A learned rule wins; AI only fills a gap or replaces an
 * obsolete AI rule whose folder is no longer configured.
 * Returns true when the rules changed.
 */
export function setRule(senders, address, folder, source, folderNames) {
  const key = normalizeAddress(address);
  const existing = senders[key];
  const isConfigured = (name) => name.toUpperCase() === INBOX || folderNames.includes(name);
  const canReplaceObsoleteAi = existing?.source === 'ai' && !isConfigured(existing.folder);
  if (source === 'ai' && existing && !canReplaceObsoleteAi) return false;
  if (existing && existing.folder === folder && existing.source === source) return false;
  senders[key] = { folder, source };
  return true;
}

/**
 * Messages in the junk folder whose sender has a rule the user made (learned
 * from a move, or written by hand). AI rules don't count: they came from mail
 * that was never judged as spam, and a forged sender could otherwise pull
 * spam back out. Returns [{ uid, address, folder }]; folder may be INBOX.
 */
export function planJunk(messages, senders, folderNames) {
  const rescues = [];
  for (const m of messages) {
    if (!m.address || (m.flags || []).includes('\\Deleted')) continue;
    const rule = lookupRule(senders, m.address, folderNames);
    if (!rule || rule.source === 'ai') continue;
    rescues.push({ uid: m.uid, address: normalizeAddress(m.address), folder: rule.folder.toUpperCase() === INBOX ? INBOX : rule.folder, flags: m.flags || [] });
  }
  return rescues;
}

/**
 * The junk mailbox: an explicit path if configured, else the one marked
 * \Junk, else one named Junk or Spam (at the top or under the namespace prefix).
 */
export function findJunkMailbox(mailboxes, { configured = '', prefix = '' } = {}) {
  if (configured) {
    const want = configured.toLowerCase();
    const hit = mailboxes.find(m => m.path.toLowerCase() === want || m.path.toLowerCase() === (prefix + configured).toLowerCase());
    return hit ? hit.path : null;
  }
  const special = mailboxes.find(m => m.specialUse === '\\Junk');
  if (special) return special.path;
  for (const name of ['junk', 'spam']) {
    const hit = mailboxes.find(m => m.path.toLowerCase() === name || m.path.toLowerCase() === (prefix + name).toLowerCase());
    if (hit) return hit.path;
  }
  return null;
}

// ── AI ──────────────────────────────────────────────────────────────────────

export function buildClassificationPrompt(folders, messages) {
  const folderList = folders
    .map(f => `- "${f.name}": ${f.description || '(no description)'}`)
    .join('\n');
  const items = messages.map((m, i) => {
    const parts = [`${i + 1}. From: ${m.fromName ? `${m.fromName} <${m.address}>` : m.address}`, `   Subject: ${m.subject || '(none)'}`];
    const signals = [];
    if (m.listId) signals.push(`List-Id: ${m.listId}`);
    if (m.listUnsubscribe) signals.push('has List-Unsubscribe');
    if (m.precedence) signals.push(`Precedence: ${m.precedence}`);
    if (signals.length) parts.push(`   Headers: ${signals.join('; ')}`);
    return parts.join('\n');
  }).join('\n');

  return `You file incoming email into folders. Each sender will be filed the same way from now on, so decide what kind of sender this is.

Folders:
${folderList}
- "INBOX": anything else, especially personal mail from a real person, anything that may need a reply, and anything you are unsure about.

Messages:
${items}

Reply with only a JSON array, one object per message, in order: [{"n": 1, "folder": "<folder name or INBOX>"}, ...]. Use folder names exactly as given. When in doubt, choose "INBOX".`;
}

/**
 * Parse the AI's reply into a folder per message index (0-based).
 * Unknown folder names fall back to INBOX; unparseable replies give {}.
 */
export function parseClassification(reply, folderNames, count) {
  const match = String(reply || '').match(/\[[\s\S]*\]/);
  if (!match) return {};
  let data;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return {};
  }
  if (!Array.isArray(data)) return {};
  const byLower = new Map(folderNames.map(n => [n.toLowerCase(), n]));
  const result = {};
  for (const item of data) {
    const n = Number(item?.n);
    if (!Number.isInteger(n) || n < 1 || n > count) continue;
    const named = byLower.get(String(item.folder || '').trim().toLowerCase());
    result[n - 1] = named || INBOX;
  }
  return result;
}

// ── Mailboxes ───────────────────────────────────────────────────────────────

/**
 * The server path for a configured folder name. An existing mailbox is matched
 * by its path or by its path without the personal namespace prefix
 * (e.g. "INBOX.Receipts" for "Receipts"); otherwise the path to create.
 * A "/" in the name nests, using the server's delimiter.
 */
export function resolveMailboxPath(name, existingPaths, { prefix = '', delimiter = '/' } = {}) {
  const nested = name.split('/').map(s => s.trim()).filter(Boolean).join(delimiter || '/');
  const lower = (s) => s.toLowerCase();
  const found = existingPaths.find(p => lower(p) === lower(nested) || lower(p) === lower(prefix + nested));
  if (found) return { path: found, exists: true };
  return { path: prefix + nested, exists: false };
}
