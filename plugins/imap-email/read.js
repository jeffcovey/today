#!/usr/bin/env node

// IMAP Email Plugin - Read Command
// Syncs emails from any IMAP server to the plugin schema format
//
// Two-phase sync:
// 1. Fast metadata sync (envelope, flags, size) - runs in foreground
// 2. Body fetch (smallest first) - runs in background if enabled

import { ImapFlow } from 'imapflow';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const sourceId = process.env.SOURCE_ID || 'imap-email/default';

// Configuration with defaults
const host = config.host;
const port = config.port || 993;
const secure = config.secure !== false;
const username = config.username;
const passwordEnv = config.password_env || 'EMAIL_PASSWORD';
const password = process.env[passwordEnv];

const daysToSync = config.days_to_sync || 30;
const configuredFolders = config.folders ? config.folders.split(',').map(f => f.trim()) : null;
const excludeFolders = (config.exclude_folders || 'Junk,Trash,Deleted Messages,Deleted Items,Spam,[Gmail]/Spam,[Gmail]/Trash,Drafts')
  .split(',').map(f => f.trim().toLowerCase());
const includeBody = config.include_body !== false;
const maxBodySize = config.max_body_size || 50000;

// Validate required settings
if (!host) {
  console.error('Error: IMAP host not configured');
  console.log(JSON.stringify({ entries: [], metadata: { error: 'host not configured' } }));
  process.exit(0);
}

if (!username) {
  console.error('Error: IMAP username not configured');
  console.log(JSON.stringify({ entries: [], metadata: { error: 'username not configured' } }));
  process.exit(0);
}

if (!password) {
  console.error(`Error: Password not found in environment variable ${passwordEnv}`);
  console.log(JSON.stringify({ entries: [], metadata: { error: `${passwordEnv} not set` } }));
  process.exit(0);
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

// Calculate cutoff date
const sinceDate = new Date();
sinceDate.setDate(sinceDate.getDate() - daysToSync);

const entries = [];
const emailsNeedingBodies = []; // Track for background fetch
const metadata = {
  folders_synced: [],
  total_fetched: 0,
  bodies_pending: 0,
  errors: []
};

async function syncFolder(folderPath) {
  console.error(`  📁 ${folderPath}...`);

  try {
    const lock = await client.getMailboxLock(folderPath);
    let folderCount = 0;

    try {
      // Fast metadata-only fetch
      for await (const message of client.fetch(
        { since: sinceDate },
        {
          envelope: true,
          flags: true,
          size: true
          // NOT fetching source - that's slow
        }
      )) {
        try {
          const envelope = message.envelope || {};
          const fromAddr = envelope.from?.[0];
          const toAddrs = envelope.to || [];
          const ccAddrs = envelope.cc || [];

          // Convert IMAP flags to our format
          const flags = [];
          if (message.flags) {
            if (message.flags.has('\\Seen')) flags.push('seen');
            if (message.flags.has('\\Flagged')) flags.push('flagged');
            if (message.flags.has('\\Answered')) flags.push('answered');
            if (message.flags.has('\\Draft')) flags.push('draft');
            if (message.flags.has('\\Deleted')) flags.push('deleted');
          }

          const entry = {
            id: `${folderPath}:${message.uid}`,
            message_id: envelope.messageId || `uid-${message.uid}`,
            from_address: fromAddr ? (fromAddr.address || '') : '',
            from_name: fromAddr ? (fromAddr.name || '') : '',
            to_addresses: JSON.stringify(toAddrs.map(a => ({ address: a.address, name: a.name }))),
            cc_addresses: ccAddrs.length > 0
              ? JSON.stringify(ccAddrs.map(a => ({ address: a.address, name: a.name })))
              : null,
            reply_to: envelope.replyTo?.[0]?.address || null,
            subject: envelope.subject || '',
            date: envelope.date ? envelope.date.toISOString() : new Date().toISOString(),
            folder: folderPath,
            flags: JSON.stringify(flags),
            size: message.size || 0,
            snippet: null,  // Will be filled by background fetch
            text_content: null,
            html_content: null,
            attachments: null,
            metadata: JSON.stringify({
              uid: message.uid,
              modseq: message.modseq ? message.modseq.toString() : null,
              needs_body: includeBody
            })
          };

          entries.push(entry);
          folderCount++;

          // Track for background body fetch
          if (includeBody) {
            emailsNeedingBodies.push({
              folder: folderPath,
              uid: message.uid,
              size: message.size || 0
            });
          }

        } catch (parseError) {
          metadata.errors.push(`Error parsing message ${message.uid}: ${parseError.message}`);
        }
      }

      metadata.folders_synced.push({ folder: folderPath, count: folderCount });
      metadata.total_fetched += folderCount;
      console.error(`     ✓ ${folderCount} emails`);

    } finally {
      lock.release();
    }

  } catch (folderError) {
    metadata.errors.push(`Error syncing folder ${folderPath}: ${folderError.message}`);
    console.error(`     ✗ Error: ${folderError.message}`);
  }
}

async function main() {
  try {
    console.error(`Connecting to ${host}...`);
    await client.connect();
    console.error(`✓ Connected as ${username}`);

    // Determine which folders to sync
    let foldersToSync = configuredFolders;

    if (!foldersToSync) {
      // Auto-discover folders, excluding junk/trash/spam
      const allFolders = await client.list();
      foldersToSync = allFolders
        .filter(f => {
          // Skip system folders that start with [
          if (f.path.startsWith('[')) return false;
          // Skip Notes folder (iCloud specific)
          if (f.path === 'Notes') return false;
          // Skip excluded folders (junk, trash, spam, etc.) and their subfolders
          const lowerPath = f.path.toLowerCase();
          return !excludeFolders.some(ex =>
            lowerPath === ex ||
            lowerPath.startsWith(ex + '/') ||
            lowerPath.endsWith('/' + ex)
          );
        })
        .map(f => f.path);

      console.error(`  Auto-discovered ${foldersToSync.length} folders`);
    }

    // Sync each folder (metadata only - fast)
    for (const folder of foldersToSync) {
      await syncFolder(folder);
    }

    await client.logout();

    // Summary
    console.error(`✓ Synced ${metadata.total_fetched} emails from ${metadata.folders_synced.length} folder(s)`);

    // Launch background body fetch if needed
    if (includeBody && emailsNeedingBodies.length > 0) {
      metadata.bodies_pending = emailsNeedingBodies.length;

      // Sort by size (smallest first) for faster initial results
      emailsNeedingBodies.sort((a, b) => a.size - b.size);

      // Write pending list to temp file for background process
      // Include actual password since background process won't have dotenvx
      const pendingFile = `/tmp/imap-bodies-${Date.now()}.json`;
      const fs = await import('fs');
      fs.writeFileSync(pendingFile, JSON.stringify({
        config: { host, port, secure, username, password, maxBodySize },
        emails: emailsNeedingBodies,
        sourceId
      }), { mode: 0o600 }); // Restrict permissions

      // Spawn background process
      const bgProcess = spawn('node', [path.join(__dirname, 'fetch-bodies.js'), pendingFile], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
      });
      bgProcess.unref();

      console.error(`  📥 Fetching ${emailsNeedingBodies.length} bodies in background (smallest first)`);
    }

  } catch (error) {
    metadata.errors.push(`Connection error: ${error.message}`);
    console.error(`Error: ${error.message}`);
  }

  // Output in plugin format
  console.log(JSON.stringify({
    entries,
    metadata
  }));
}

main();
