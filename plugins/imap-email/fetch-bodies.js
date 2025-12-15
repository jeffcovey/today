#!/usr/bin/env node

// Background body fetcher for IMAP Email Plugin
// Fetches email bodies sorted by size (smallest first)
// Updates database directly

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'fs';
import Database from 'better-sqlite3';
import path from 'path';

// Lock file to prevent multiple background fetchers
const LOCK_FILE = '/tmp/imap-email-fetch.lock';

function createLockFile(sourceId) {
  fs.writeFileSync(LOCK_FILE, `${process.pid}:${sourceId}`, { mode: 0o644 });
}

function removeLockFile() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// Clean up lock file on exit
process.on('exit', removeLockFile);
process.on('SIGTERM', () => { removeLockFile(); process.exit(0); });
process.on('SIGINT', () => { removeLockFile(); process.exit(0); });

const pendingFile = process.argv[2];

if (!pendingFile || !fs.existsSync(pendingFile)) {
  console.error('No pending file specified or file not found');
  process.exit(1);
}

// Read pending list
const { config, emails, sourceId } = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));

// Clean up temp file
fs.unlinkSync(pendingFile);

// Create lock file
createLockFile(sourceId);

if (!emails || emails.length === 0) {
  console.error('No emails to fetch');
  process.exit(0);
}

const { host, port, secure, username, password, maxBodySize } = config;

if (!password) {
  console.error('Password not provided in config');
  process.exit(1);
}

// Open database with WAL mode and busy timeout for concurrent access
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const dbPath = path.join(projectRoot, '.data', 'today.db');
const db = new Database(dbPath, { timeout: 30000 });
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');

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

// Group emails by folder for efficient fetching
const byFolder = {};
for (const email of emails) {
  if (!byFolder[email.folder]) {
    byFolder[email.folder] = [];
  }
  byFolder[email.folder].push(email);
}

// Sort each folder's emails by size (already sorted overall, but re-sort per folder)
for (const folder of Object.keys(byFolder)) {
  byFolder[folder].sort((a, b) => a.size - b.size);
}

async function fetchBodiesForFolder(folderPath, emailList) {
  const lock = await client.getMailboxLock(folderPath);
  let fetched = 0;

  try {
    for (const email of emailList) {
      try {
        // Fetch single message source
        const message = await client.fetchOne(email.uid, { source: true }, { uid: true });

        if (message && message.source) {
          const parsed = await simpleParser(message.source);

          let textContent = parsed.text || '';
          let htmlContent = parsed.html || '';
          const attachments = parsed.attachments?.map(a => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size
          })) || [];

          // Truncate if too large
          if (textContent.length > maxBodySize) {
            textContent = textContent.substring(0, maxBodySize) + '\n[truncated]';
          }
          if (htmlContent.length > maxBodySize) {
            htmlContent = htmlContent.substring(0, maxBodySize) + '\n[truncated]';
          }

          // Generate snippet
          const snippet = textContent
            ? textContent.substring(0, 200).replace(/\s+/g, ' ').trim()
            : '';

          // Update database - ID includes source prefix
          const id = `${sourceId}:${folderPath}:${email.uid}`;
          db.prepare(`
            UPDATE email
            SET snippet = ?, text_content = ?, html_content = ?, attachments = ?,
                metadata = json_set(metadata, '$.needs_body', false)
            WHERE id = ?
          `).run(
            snippet,
            textContent,
            htmlContent,
            attachments.length > 0 ? JSON.stringify(attachments) : null,
            id
          );

          fetched++;
        }
      } catch (err) {
        // Skip individual failures
        console.error(`  Failed to fetch ${email.uid}: ${err.message}`);
      }
    }
  } finally {
    lock.release();
  }

  return fetched;
}

async function main() {
  let totalFetched = 0;

  try {
    await client.connect();
    console.error(`📥 Background body fetch: ${emails.length} emails`);

    // Process folders in order (emails are already sorted by size overall)
    for (const [folder, emailList] of Object.entries(byFolder)) {
      console.error(`  ${folder}: ${emailList.length} emails...`);
      const fetched = await fetchBodiesForFolder(folder, emailList);
      totalFetched += fetched;
      console.error(`    ✓ ${fetched} bodies fetched`);
    }

    await client.logout();
    console.error(`✓ Fetched ${totalFetched} email bodies`);

  } catch (error) {
    console.error(`Error: ${error.message}`);
  }

  db.close();
}

main();
