#!/usr/bin/env node

// IMAP Email Plugin - Read Command
// Syncs emails from any IMAP server to the plugin schema format
//
// Supports incremental sync:
// - Stores UIDVALIDITY and UIDNEXT per folder
// - Only fetches new messages on subsequent syncs
// - Falls back to full sync if UIDVALIDITY changes
//
// Two-phase sync:
// 1. Fast metadata sync (envelope, flags, size) - runs in foreground
// 2. Body fetch (smallest first) - runs in background if enabled

import { ImapFlow } from 'imapflow';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lock file to prevent multiple background fetchers
const LOCK_FILE = '/tmp/imap-email-fetch.lock';
const LOCK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes - assume stale if older

function isBackgroundFetcherRunning() {
  if (!fs.existsSync(LOCK_FILE)) return false;

  try {
    const stat = fs.statSync(LOCK_FILE);
    const ageMs = Date.now() - stat.mtimeMs;

    // If lock is too old, it's probably stale (crashed process)
    if (ageMs > LOCK_MAX_AGE_MS) {
      fs.unlinkSync(LOCK_FILE);
      return false;
    }

    // Check if the PID in the lock file is still running
    const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    const [pid, sourceId] = content.split(':');

    if (pid) {
      try {
        // Check if process is still running (signal 0 doesn't kill, just checks)
        process.kill(parseInt(pid), 0);
        return { running: true, pid, sourceId };
      } catch {
        // Process not running, remove stale lock
        fs.unlinkSync(LOCK_FILE);
        return false;
      }
    }
  } catch {
    return false;
  }

  return false;
}

// Get existing email data (including bodies) to avoid re-fetching and preserve content
function getExistingEmailData(sourceId) {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const dbPath = path.join(projectRoot, '.data', 'today.db');

  try {
    const db = new Database(dbPath, { readonly: true, timeout: 5000 });
    db.pragma('busy_timeout = 5000');

    // Get emails that already have bodies fetched, including their content
    const existing = db.prepare(`
      SELECT id, snippet, text_content, html_content, attachments
      FROM email
      WHERE source = ?
        AND (json_extract(metadata, '$.needs_body') = false
             OR text_content IS NOT NULL)
    `).all(sourceId);

    db.close();

    // Return map of IDs (without source prefix) to their body content
    // IDs in DB are like: "imap-email/icloud:INBOX:12345"
    // We need to extract: "INBOX:12345"
    const emailMap = new Map();
    const prefix = sourceId + ':';
    for (const row of existing) {
      if (row.id.startsWith(prefix)) {
        const localId = row.id.substring(prefix.length);
        emailMap.set(localId, {
          snippet: row.snippet,
          text_content: row.text_content,
          html_content: row.html_content,
          attachments: row.attachments
        });
      }
    }
    return emailMap;
  } catch (err) {
    // Database might not exist yet on first run
    return new Map();
  }
}

// Get stored folder state from sync_metadata
function getFolderState(sourceId) {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const dbPath = path.join(projectRoot, '.data', 'today.db');

  try {
    const db = new Database(dbPath, { readonly: true, timeout: 5000 });
    db.pragma('busy_timeout = 5000');

    const row = db.prepare(`
      SELECT extra_data FROM sync_metadata WHERE source = ?
    `).get(sourceId);

    db.close();

    if (row && row.extra_data) {
      const data = JSON.parse(row.extra_data);
      return data.folder_state || {};
    }
    return {};
  } catch (err) {
    return {};
  }
}

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const sourceId = process.env.SOURCE_ID || 'imap-email/default';
const lastSyncTime = process.env.LAST_SYNC_TIME || '';

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

// Calculate cutoff date for full syncs
const sinceDate = new Date();
sinceDate.setDate(sinceDate.getDate() - daysToSync);

const entries = [];
const emailsNeedingBodies = []; // Track for background fetch
const metadata = {
  folders_synced: [],
  total_fetched: 0,
  bodies_pending: 0,
  bodies_skipped: 0,
  errors: [],
  incremental: false
};

// Will be populated with emails that already have bodies fetched (Map of id -> body content)
let existingEmails = new Map();

// Folder state for incremental sync
let previousFolderState = {};
const newFolderState = {};

async function syncFolder(folderPath, isIncremental, lastState) {
  try {
    const lock = await client.getMailboxLock(folderPath);
    let folderCount = 0;
    let syncType = 'full';

    try {
      // Get current folder status
      // Convert BigInt to Number (safe for UIDs which are typically < 2^53)
      const status = client.mailbox;
      const currentUidValidity = Number(status.uidValidity);
      const currentUidNext = Number(status.uidNext);

      // Determine sync strategy
      let fetchQuery;

      if (isIncremental && lastState && lastState.uidValidity === currentUidValidity) {
        // UIDVALIDITY matches - we can do incremental sync
        // Fetch only messages with UID >= last UIDNEXT
        if (lastState.uidNext && currentUidNext > lastState.uidNext) {
          fetchQuery = { uid: `${lastState.uidNext}:*` };
          syncType = 'incremental';
          console.error(`  📁 ${folderPath} (new: ${currentUidNext - lastState.uidNext})...`);
        } else {
          // No new messages
          console.error(`  📁 ${folderPath} (no new)...`);
          newFolderState[folderPath] = {
            uidValidity: currentUidValidity,
            uidNext: currentUidNext
          };
          metadata.folders_synced.push({ folder: folderPath, count: 0, type: 'skip' });
          lock.release();
          return;
        }
      } else {
        // Full sync needed (first sync or UIDVALIDITY changed)
        fetchQuery = { since: sinceDate };
        if (lastState && lastState.uidValidity !== currentUidValidity) {
          console.error(`  📁 ${folderPath} (UIDVALIDITY changed, full sync)...`);
        } else {
          console.error(`  📁 ${folderPath}...`);
        }
      }

      // Store new folder state
      newFolderState[folderPath] = {
        uidValidity: currentUidValidity,
        uidNext: currentUidNext
      };

      // Fast metadata-only fetch
      for await (const message of client.fetch(
        fetchQuery,
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

          const emailId = `${folderPath}:${message.uid}`;
          const existingData = existingEmails.get(emailId);
          const hasBody = !!existingData;

          const entry = {
            id: emailId,
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
            // Preserve existing body content if already fetched
            snippet: existingData?.snippet || null,
            text_content: existingData?.text_content || null,
            html_content: existingData?.html_content || null,
            attachments: existingData?.attachments || null,
            metadata: JSON.stringify({
              uid: message.uid,
              modseq: message.modseq ? message.modseq.toString() : null,
              needs_body: includeBody && !hasBody  // Don't mark as needing body if already fetched
            })
          };

          entries.push(entry);
          folderCount++;

          // Track for background body fetch (only if body not already fetched)
          if (includeBody && !hasBody) {
            emailsNeedingBodies.push({
              folder: folderPath,
              uid: message.uid,
              size: message.size || 0
            });
          } else if (includeBody && hasBody) {
            metadata.bodies_skipped++;
          }

        } catch (parseError) {
          metadata.errors.push(`Error parsing message ${message.uid}: ${parseError.message}`);
        }
      }

      metadata.folders_synced.push({ folder: folderPath, count: folderCount, type: syncType });
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
    // Check for incremental sync
    const isIncremental = !!lastSyncTime;
    if (isIncremental) {
      previousFolderState = getFolderState(sourceId);
      metadata.incremental = true;
    }

    // Check which emails already have bodies to avoid re-fetching
    existingEmails = getExistingEmailData(sourceId);
    if (existingEmails.size > 0 && !isIncremental) {
      console.error(`  Found ${existingEmails.size} emails with bodies already fetched`);
    }

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

      if (!isIncremental) {
        console.error(`  Auto-discovered ${foldersToSync.length} folders`);
      }
    }

    // Sync each folder (metadata only - fast)
    for (const folder of foldersToSync) {
      const lastState = previousFolderState[folder];
      await syncFolder(folder, isIncremental, lastState);
    }

    await client.logout();

    // Summary
    const newCount = metadata.folders_synced.reduce((sum, f) =>
      f.type === 'incremental' || f.type === 'full' ? sum + f.count : sum, 0);
    const skippedFolders = metadata.folders_synced.filter(f => f.type === 'skip').length;

    if (isIncremental && skippedFolders > 0) {
      console.error(`✓ Synced ${newCount} new emails (${skippedFolders} folders unchanged)`);
    } else {
      console.error(`✓ Synced ${metadata.total_fetched} emails from ${metadata.folders_synced.length} folder(s)`);
    }

    // Launch background body fetch if needed (only for emails without bodies)
    if (includeBody && emailsNeedingBodies.length > 0) {
      metadata.bodies_pending = emailsNeedingBodies.length;

      // Check if a background fetcher is already running
      const existingFetcher = isBackgroundFetcherRunning();
      if (existingFetcher && existingFetcher.running) {
        console.error(`  ⏳ Background fetcher already running (PID ${existingFetcher.pid}) - skipping new fetch`);
        if (metadata.bodies_skipped > 0) {
          console.error(`  ✓ Skipped ${metadata.bodies_skipped} emails (bodies already fetched)`);
        }
        metadata.bodies_pending = 0; // Don't report pending since we're not starting a new fetch
      } else {
        // Sort by size (smallest first) for faster initial results
        emailsNeedingBodies.sort((a, b) => a.size - b.size);

        // Write pending list to temp file for background process
        // Include actual password since background process won't have dotenvx
        const pendingFile = `/tmp/imap-bodies-${Date.now()}.json`;
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

        console.error(`  📥 Fetching ${emailsNeedingBodies.length} NEW bodies in background (smallest first)`);
        if (metadata.bodies_skipped > 0) {
          console.error(`  ✓ Skipped ${metadata.bodies_skipped} emails (bodies already fetched)`);
        }
      }
    } else if (includeBody && metadata.bodies_skipped > 0) {
      console.error(`  ✓ All ${metadata.bodies_skipped} email bodies already fetched`);
    }

    // Store folder state for next incremental sync
    metadata.folder_state = newFolderState;

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
