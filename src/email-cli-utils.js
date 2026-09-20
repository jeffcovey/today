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
