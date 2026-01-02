#!/usr/bin/env node

// IMAP Email Plugin - Write Command
// Supports move and delete operations on emails

import { ImapFlow } from 'imapflow';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const entryJson = process.env.ENTRY_JSON;

if (!entryJson) {
  console.error('Error: No entry data provided');
  console.log(JSON.stringify({ success: false, error: 'No entry data' }));
  process.exit(1);
}

const entry = JSON.parse(entryJson);

// Configuration
const host = config.host;
const port = config.port || 993;
const secure = config.secure !== false;
const username = config.username;
const passwordEnv = config.password_env || 'EMAIL_PASSWORD';
const password = process.env[passwordEnv];

// Validate required settings
if (!host || !username || !password) {
  console.log(JSON.stringify({
    success: false,
    error: 'IMAP not configured (host, username, or password missing)'
  }));
  process.exit(1);
}

// Create IMAP client
const client = new ImapFlow({
  host,
  port,
  secure,
  auth: {
    user: username,
    pass: password
  },
  logger: false
});

async function main() {
  const action = entry.action;

  if (!action) {
    console.log(JSON.stringify({ success: false, error: 'No action specified' }));
    process.exit(1);
  }

  try {
    await client.connect();

    switch (action) {
      case 'move':
        await moveEmails(entry);
        break;

      case 'delete':
        await deleteEmails(entry);
        break;

      case 'flag':
        await flagEmails(entry);
        break;

      case 'mark-read':
        await markRead(entry);
        break;

      case 'mark-unread':
        await markUnread(entry);
        break;

      default:
        console.log(JSON.stringify({ success: false, error: `Unknown action: ${action}` }));
        process.exit(1);
    }

    await client.logout();

  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error.message }));
    process.exit(1);
  }
}

async function moveEmails(entry) {
  const { uids, source_folder, target_folder } = entry;

  if (!uids || !source_folder || !target_folder) {
    console.log(JSON.stringify({
      success: false,
      error: 'move requires uids, source_folder, and target_folder'
    }));
    process.exit(1);
  }

  const lock = await client.getMailboxLock(source_folder);
  try {
    await client.messageMove(uids, target_folder, { uid: true });
    console.log(JSON.stringify({
      success: true,
      moved: uids.length,
      from: source_folder,
      to: target_folder,
      needs_sync: true
    }));
  } finally {
    lock.release();
  }
}

async function deleteEmails(entry) {
  const { uids, folder } = entry;

  if (!uids || !folder) {
    console.log(JSON.stringify({
      success: false,
      error: 'delete requires uids and folder'
    }));
    process.exit(1);
  }

  // Try to find trash folder
  const folders = await client.list();
  const trashFolder = folders.find(f =>
    f.specialUse === '\\Trash' ||
    (Array.isArray(f.specialUse) && f.specialUse.includes('\\Trash')) ||
    f.path.toLowerCase() === 'trash' ||
    f.path === 'Deleted Messages'
  );

  const lock = await client.getMailboxLock(folder);
  try {
    if (trashFolder && folder !== trashFolder.path) {
      // Move to trash
      await client.messageMove(uids, trashFolder.path, { uid: true });
      console.log(JSON.stringify({
        success: true,
        deleted: uids.length,
        method: 'moved_to_trash',
        trash_folder: trashFolder.path,
        needs_sync: true
      }));
    } else {
      // Mark as deleted
      await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
      console.log(JSON.stringify({
        success: true,
        deleted: uids.length,
        method: 'flagged_deleted',
        needs_sync: true
      }));
    }
  } finally {
    lock.release();
  }
}

async function flagEmails(entry) {
  const { uids, folder, flag, add } = entry;

  if (!uids || !folder || !flag) {
    console.log(JSON.stringify({
      success: false,
      error: 'flag requires uids, folder, and flag'
    }));
    process.exit(1);
  }

  const lock = await client.getMailboxLock(folder);
  try {
    if (add !== false) {
      await client.messageFlagsAdd(uids, [flag], { uid: true });
    } else {
      await client.messageFlagsRemove(uids, [flag], { uid: true });
    }
    console.log(JSON.stringify({
      success: true,
      flagged: uids.length,
      flag,
      action: add !== false ? 'added' : 'removed',
      needs_sync: true
    }));
  } finally {
    lock.release();
  }
}

async function markRead(entry) {
  const { uids, folder } = entry;

  if (!uids || !folder) {
    console.log(JSON.stringify({
      success: false,
      error: 'mark-read requires uids and folder'
    }));
    process.exit(1);
  }

  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    console.log(JSON.stringify({
      success: true,
      marked_read: uids.length,
      needs_sync: true
    }));
  } finally {
    lock.release();
  }
}

async function markUnread(entry) {
  const { uids, folder } = entry;

  if (!uids || !folder) {
    console.log(JSON.stringify({
      success: false,
      error: 'mark-unread requires uids and folder'
    }));
    process.exit(1);
  }

  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
    console.log(JSON.stringify({
      success: true,
      marked_unread: uids.length,
      needs_sync: true
    }));
  } finally {
    lock.release();
  }
}

main();
