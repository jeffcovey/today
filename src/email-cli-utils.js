import { getEncryptedEnvVarName } from './encrypted-settings.js';

export function getImapPasswordEnvKey(sourceName) {
  return getEncryptedEnvVarName('imap-email', sourceName, 'password');
}

export function addExactSourceCondition(conditions, params, source) {
  const sourceId = source.startsWith('imap-email/') ? source : `imap-email/${source}`;
  if (sourceId === source) {
    conditions.push('source = ?');
    params.push(source);
    return;
  }
  conditions.push('(source = ? OR source = ?)');
  params.push(source, sourceId);
}

export async function withConnectedImapClient(client, action) {
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await action(client);
  } finally {
    if (connected) {
      try { await client.logout(); } catch { /* ignore logout errors */ }
    }
  }
}

// A UID search returns matches in ascending UID order, which within a folder is
// effectively oldest first. Taking the front of that list yields the oldest
// messages and hides recent ones, so take the back instead.
export function newestUids(uids, limit) {
  if (!Array.isArray(uids) || uids.length === 0) return [];
  const sorted = [...uids].sort((a, b) => a - b);
  if (!Number.isFinite(limit) || limit <= 0) return sorted;
  return sorted.slice(-limit);
}

// Results arrive folder by folder, so ordering and truncation must happen once
// across the whole set. Truncating per folder is what let a search report
// nothing newer than 2019 while recent matches sat in a folder it had already
// filled its quota from.
export function rankSearchResults(results, limit) {
  const ranked = [...results].sort((a, b) => {
    const dateA = a?.date ? new Date(a.date).getTime() : 0;
    const dateB = b?.date ? new Date(b.date).getTime() : 0;
    return dateB - dateA;
  });
  if (!Number.isFinite(limit) || limit <= 0) return ranked;
  return ranked.slice(0, limit);
}

// Folders the search should skip: IMAP namespace containers and Apple's Notes
// mailbox, which holds notes rather than mail.
export function searchableFolders(folders) {
  return (folders || [])
    .filter(f => f?.path && !f.path.startsWith('[') && f.path !== 'Notes')
    .filter(f => !f.flags || !f.flags.has || !f.flags.has('\\Noselect'))
    .map(f => f.path);
}
