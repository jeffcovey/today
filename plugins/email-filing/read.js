#!/usr/bin/env node

// Email filing plugin: moves inbox mail into described folders and learns
// sender rules from the messages the user moves. See plugin.toml.
//
// Output: utility JSON on stdout ({ cleaned, message }); progress on stderr.

import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import { getFullConfig, getAppDirectory } from '../../src/config.js';
import { getEncryptedEnvVarName, getEnvVar } from '../../src/encrypted-settings.js';
import { resolveAppPath } from '../../src/vault-app-files.js';
import { writeFileAtomicCAS } from '../../src/fs-atomic.js';
import { createCompletion, isAIAvailable } from '../../src/ai-provider.js';
import {
  INBOX, folderKeyword, isFilingKeyword, parseFolders, parseRules, serializeRules,
  learnFromFolders, planInbox, planJunk, findJunkMailbox, setRule, buildClassificationPrompt,
  parseClassification, resolveMailboxPath, mergeRuleChanges,
} from './filing.js';

export const RULES_FILENAME = 'email-rules.toml';
const AI_BATCH_SIZE = 25;

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const sourceName = (process.env.SOURCE_ID || 'email-filing/default').split('/').pop();
const dryRun = config.dry_run === true;
const rescueJunk = config.rescue_junk !== false;
const learnDays = Number(config.learn_days ?? 30);
const maxAiMessages = Number(config.max_ai_messages ?? 100);
const folders = parseFolders(config.folders);
const folderNames = folders.map(f => f.name);

const log = (msg) => console.error(msg);

// A dry run's decisions, returned in the summary so `bin/plugins sync`,
// which shows only the summary, lists them too.
const report = [];
const note = (line) => {
  log(line);
  if (dryRun) report.push(line);
};

function finish(cleaned, message, success = true) {
  console.log(JSON.stringify(success ? { cleaned, message } : { success: false, error: message }));
}

function imapSettings() {
  const emailSource = config.email_source;
  if (!emailSource) throw new Error('email_source is not set');
  const imap = getFullConfig().plugins?.['imap-email']?.[emailSource];
  if (!imap) throw new Error(`No imap-email source named "${emailSource}"`);
  const envName = getEncryptedEnvVarName('imap-email', emailSource, 'password');
  const password = process.env[envName] || getEnvVar(envName)
    || (imap.password_env ? process.env[imap.password_env] : null);
  if (!imap.host || !imap.username || !password) {
    throw new Error(`imap-email source "${emailSource}" is missing a host, username or password`);
  }
  return { host: imap.host, port: imap.port || 993, secure: imap.secure !== false, auth: { user: imap.username, pass: password } };
}

// ── Rules file ──────────────────────────────────────────────────────────────

function rulesPath() {
  return resolveAppPath(process.env.VAULT_PATH, RULES_FILENAME, getAppDirectory());
}

function readRulesFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Re-apply changes only where the sender still matches the sync-start snapshot.
function saveRules(file, changes, initialSenders, configuredFolders) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = readRulesFile(file);
    const all = parseRules(before || '');
    const senders = all[sourceName] || {};
    const { changed, nextSnapshot } = mergeRuleChanges(senders, changes, initialSenders, configuredFolders);
    if (!changed) return;
    all[sourceName] = senders;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!writeFileAtomicCAS(file, serializeRules(all), before).conflict) {
      for (const address of Object.keys(initialSenders)) {
        if (!Object.hasOwn(nextSnapshot, address)) delete initialSenders[address];
      }
      Object.assign(initialSenders, nextSnapshot);
      return;
    }
  }
  throw new Error(`Could not write ${file}: it kept changing`);
}

// ── IMAP helpers ────────────────────────────────────────────────────────────

function headerValue(raw, name) {
  if (!raw) return '';
  const unfolded = raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const match = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
  return match ? match[1].trim() : '';
}

function toMessage(msg, folder) {
  const from = msg.envelope?.from?.[0] || {};
  return {
    folder,
    uid: msg.uid,
    address: from.address || '',
    fromName: from.name || '',
    subject: msg.envelope?.subject || '',
    date: msg.internalDate || msg.envelope?.date,
    flags: [...(msg.flags || [])],
    listId: headerValue(msg.headers, 'list-id'),
    listUnsubscribe: Boolean(headerValue(msg.headers, 'list-unsubscribe')),
    precedence: headerValue(msg.headers, 'precedence'),
  };
}

async function fetchMessages(client, folder, query) {
  const uids = await client.search(query, { uid: true });
  if (!uids || uids.length === 0) return [];
  const out = [];
  for await (const msg of client.fetch(uids, {
    uid: true, envelope: true, flags: true, internalDate: true,
    headers: ['list-id', 'list-unsubscribe', 'precedence'],
  }, { uid: true })) {
    out.push(toMessage(msg, folder));
  }
  return out;
}

// Make a message carry exactly one filing keyword: the one for `folder`.
async function retag(client, uid, flags, folder) {
  const keep = folderKeyword(folder);
  const stale = flags.filter(f => isFilingKeyword(f) && f !== keep);
  if (stale.length) await client.messageFlagsRemove(String(uid), stale, { uid: true });
  if (!flags.includes(keep)) await client.messageFlagsAdd(String(uid), [keep], { uid: true });
}

// Move messages out of the open mailbox, tagging each with its destination's
// keyword first so the tag travels with it. `paths` gains any folder created.
async function moveMessages(client, moves, paths, { keywordsSupported, extraAdd = [], extraRemove = [], verb = 'Filing', dryVerb = 'Would file' }) {
  const byFolder = new Map();
  for (const mv of moves) {
    if (!byFolder.has(mv.folder)) byFolder.set(mv.folder, []);
    byFolder.get(mv.folder).push(mv);
  }
  for (const [folder, group] of byFolder) {
    note(`  ${dryRun ? dryVerb : verb} ${group.length} message(s) into ${folder}`);
    if (dryRun) {
      for (const mv of group) note(`    ${mv.address}${mv.subject ? ` — ${mv.subject}` : ''}`);
      continue;
    }
    const target = folder === INBOX ? { path: INBOX, exists: true } : paths[folder];
    if (!target.exists) {
      const created = await client.mailboxCreate(target.path);
      paths[folder] = { path: created.path, exists: true };
    }
    const range = group.map(mv => mv.uid).join(',');
    if (keywordsSupported) {
      const destinationKeyword = folderKeyword(folder);
      const removeFlags = [...new Set([
        ...extraRemove,
        ...group.flatMap(mv => (mv.flags || []).filter(flag => isFilingKeyword(flag) && flag !== destinationKeyword)),
      ])];
      const addFlags = [...new Set([destinationKeyword, ...extraAdd])];
      if (removeFlags.length) await client.messageFlagsRemove(range, removeFlags, { uid: true });
      await client.messageFlagsAdd(range, addFlags, { uid: true });
      try {
        await client.messageMove(range, paths[folder]?.path || INBOX, { uid: true });
      } catch (err) {
        for (const mv of group) {
          const originalFlags = mv.flags || [];
          const added = addFlags.filter(flag => !originalFlags.includes(flag));
          const removed = removeFlags.filter(flag => originalFlags.includes(flag));
          if (added.length) {
            try {
              await client.messageFlagsRemove(String(mv.uid), added, { uid: true });
            } catch (restoreErr) {
              log(`  Could not remove new filing keywords for message ${mv.uid}: ${restoreErr.message}`);
            }
          }
          if (removed.length) {
            try {
              await client.messageFlagsAdd(String(mv.uid), removed, { uid: true });
            } catch (restoreErr) {
              log(`  Could not restore filing keywords for message ${mv.uid}: ${restoreErr.message}`);
            }
          }
        }
        throw err;
      }
    } else {
      await client.messageMove(range, paths[folder]?.path || INBOX, { uid: true });
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function classify(unknown) {
  const decisions = new Map();
  if (unknown.length === 0) return decisions;
  if (!(await isAIAvailable())) {
    log('  AI is not available; unfiled messages wait for the next sync');
    return decisions;
  }
  // One question per sender: later messages from the same sender follow the answer.
  const bySender = new Map();
  for (const m of unknown) {
    const key = m.address.toLowerCase();
    if (!bySender.has(key)) bySender.set(key, m);
  }
  const samples = [...bySender.values()].slice(0, maxAiMessages);
  for (let i = 0; i < samples.length; i += AI_BATCH_SIZE) {
    const batch = samples.slice(i, i + AI_BATCH_SIZE);
    try {
      const reply = await createCompletion({
        messages: [{ role: 'user', content: buildClassificationPrompt(folders, batch) }],
        maxTokens: 50 * batch.length + 100,
        temperature: 0,
      });
      const parsed = parseClassification(reply, folderNames, batch.length);
      batch.forEach((m, idx) => {
        if (parsed[idx]) decisions.set(m.address.toLowerCase(), parsed[idx]);
      });
    } catch (err) {
      log(`  AI classification failed: ${err.message}`);
    }
  }
  return decisions;
}

async function main() {
  if (folders.length === 0) {
    finish(0, 'No folders configured; nothing to file');
    return;
  }

  const file = rulesPath();
  const allRules = parseRules(readRulesFile(file) || '');
  const initialSenders = { ...(allRules[sourceName] || {}) };
  const senders = { ...initialSenders };
  const changes = [];
  let ruleChangeCount = 0;
  const record = (address, folder, source) => {
    if (setRule(senders, address, folder, source, folderNames)) {
      if (source === 'learned') note(`  ${dryRun ? 'Would learn' : 'Learned'}: ${address} → ${folder}`);
      changes.push({ address, folder, source });
      ruleChangeCount++;
    }
  };
  const persistChanges = () => {
    if (changes.length && !dryRun) {
      saveRules(file, changes, initialSenders, folderNames);
      changes.length = 0;
    }
  };

  const client = new ImapFlow({ ...imapSettings(), logger: false });
  await client.connect();
  let filed = 0;
  let learned = 0;
  let rescuedCount = 0;
  try {
    const mailboxes = await client.list();
    const existingPaths = mailboxes.map(m => m.path);
    const ns = client.namespace || {};
    const nsOpts = { prefix: ns.prefix || '', delimiter: ns.delimiter || mailboxes[0]?.delimiter || '/' };
    const paths = Object.fromEntries(folderNames.map(n => [n, resolveMailboxPath(n, existingPaths, nsOpts)]));

    const inboxBox = await client.mailboxOpen(INBOX);
    const keywordsSupported = !inboxBox.permanentFlags || inboxBox.permanentFlags.has('\\*');
    if (!keywordsSupported) log('  Server does not allow custom keywords; learning from moves is off');

    // 1. Gather folder-learning evidence across folders before applying it.
    const folderCandidates = [];
    if (keywordsSupported) {
      const since = new Date(Date.now() - learnDays * 86400000);
      for (const name of folderNames) {
        if (!paths[name].exists) continue;
        await client.mailboxOpen(paths[name].path);
        const candidates = await fetchMessages(client, name, { since, unKeyword: folderKeyword(name) });
        folderCandidates.push(...candidates);
        learned += candidates.length;
      }
      for (const { address, folder } of learnFromFolders(folderCandidates)) {
        record(address, folder, 'learned');
      }
      persistChanges();
      if (!dryRun) {
        for (const name of folderNames) {
          const candidates = folderCandidates.filter(candidate => candidate.folder === name);
          if (candidates.length === 0) continue;
          await client.mailboxOpen(paths[name].path);
          for (const m of candidates) {
            await retag(client, m.uid, m.flags, name);
          }
        }
      }
    }

    // 2. Rescue mail from senders you have ruled on out of the junk folder.
    let rescued = 0;
    if (rescueJunk) {
      const junkPath = findJunkMailbox(mailboxes, { configured: config.junk_folder || '', prefix: nsOpts.prefix });
      if (junkPath) {
        await client.mailboxOpen(junkPath);
        const since = new Date(Date.now() - learnDays * 86400000);
        const junk = await fetchMessages(client, junkPath, { since });
        const subjects = new Map(junk.map(m => [m.uid, m.subject]));
        const rescues = planJunk(junk, senders, folderNames).map(r => ({ ...r, subject: subjects.get(r.uid) }));
        await moveMessages(client, rescues, paths, {
          keywordsSupported, extraAdd: ['$NotJunk'], extraRemove: ['$Junk', 'Junk'], verb: 'Rescuing', dryVerb: 'Would rescue',
        });
        rescued = rescues.length;
      } else if (config.junk_folder) {
        log(`  Junk folder "${config.junk_folder}" not found`);
      }
      await client.mailboxOpen(INBOX);
    }

    // 3. Learn from messages moved back to the inbox before consuming evidence.
    await client.mailboxOpen(INBOX);
    const inbox = await fetchMessages(client, INBOX, { all: true });
    let plan = planInbox(inbox, senders, folderNames, { keywordsSupported });

    for (const m of plan.movedBack) {
      record(m.address, INBOX, 'learned');
      learned++;
    }
    persistChanges();
    if (!dryRun) {
      for (const m of plan.movedBack) {
        await client.messageFlagsRemove(String(m.uid), m.staleKeywords, { uid: true });
      }
    }
    plan = planInbox(inbox, senders, folderNames, { keywordsSupported });

    const decisions = await classify(plan.unknown);
    const moves = [...plan.moves];
    for (const m of plan.unknown) {
      const folder = decisions.get(m.address.toLowerCase());
      if (!folder) continue;
      record(m.address, folder, 'ai');
      if (folder !== INBOX) moves.push({ uid: m.uid, address: m.address, folder, subject: m.subject, flags: m.flags || [] });
    }

    const subjects = new Map(inbox.map(m => [m.uid, m.subject]));
    for (const mv of moves) mv.subject ??= subjects.get(mv.uid);
    await moveMessages(client, moves, paths, { keywordsSupported });
    filed = moves.length + rescued;
    rescuedCount = rescued;
  } finally {
    await client.logout().catch(() => {});
  }

  persistChanges();
  const parts = [`${dryRun ? 'Would file' : 'Filed'} ${filed - rescuedCount} message(s)`];
  if (rescuedCount) parts.push(`${dryRun ? 'would rescue' : 'rescued'} ${rescuedCount} from junk`);
  if (learned) parts.push(`learned from ${learned} moved message(s)`);
  if (ruleChangeCount) parts.push(`${ruleChangeCount} rule change(s)${dryRun ? ' (not saved)' : ''}`);
  finish(filed, [parts.join('; '), ...report].join('\n'));
}

main().catch((err) => {
  log(`email-filing: ${err.message}`);
  finish(0, err.message, false);
  process.exitCode = 1;
});
