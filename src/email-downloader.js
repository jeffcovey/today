import { ImapFlow } from 'imapflow';
import chalk from 'chalk';
import { SQLiteCache } from './sqlite-cache.js';
import { simpleParser } from 'mailparser';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export class EmailDownloader {
  constructor() {
    this.cache = new SQLiteCache();
  }

  async downloadEmails(account, days, options = {}) {
    const isBackground = options.background || false;
    const log = isBackground 
      ? { 
          blue: () => {}, 
          green: () => {}, 
          gray: () => {},
          yellow: () => {}
        }
      : {
          blue: (msg) => console.log(chalk.blue(msg)),
          green: (msg) => console.log(chalk.green(msg)),
          gray: (msg) => console.log(chalk.gray(msg)),
          yellow: (msg) => console.log(chalk.yellow(msg))
        };

    // Check for lock file to prevent concurrent downloads
    const lockFile = path.join(os.tmpdir(), 'email-cli-download.lock');
    
    try {
      // Check if lock file exists and if it's stale (older than 5 minutes)
      const stats = await fs.stat(lockFile);
      const lockAge = Date.now() - stats.mtimeMs;
      
      if (lockAge < 5 * 60 * 1000) { // Less than 5 minutes old
        if (!isBackground) {
          console.log(chalk.yellow('⚠️  Another download is already in progress. Please wait or try again later.'));
        }
        return;
      } else {
        // Remove stale lock file
        await fs.unlink(lockFile);
      }
    } catch (error) {
      // Lock file doesn't exist, we can proceed
    }
    
    // Create lock file
    try {
      await fs.writeFile(lockFile, process.pid.toString());
    } catch (error) {
      // Couldn't create lock file, but continue anyway
    }
    // Check for credentials
    if (!process.env.EMAIL_PASSWORD) {
      if (!isBackground) {
        console.error(chalk.red('❌ Email password not found in environment variables'));
        console.log(chalk.yellow('Run "email-cli setup" for instructions on setting up credentials'));
      }
      throw new Error('EMAIL_PASSWORD not configured');
    }

    // iCloud IMAP settings
    const client = new ImapFlow({
      host: 'imap.mail.me.com',
      port: 993,
      secure: true,
      auth: {
        user: account,
        pass: process.env.EMAIL_PASSWORD
      },
      logger: false // Set to console for debugging
    });

    try {
      // Connect to IMAP
      log.blue(`🔌 Connecting to iCloud email for ${account}...`);
      await client.connect();
      log.green('✅ Connected successfully');

      // Initialize database table for emails
      await this.initializeEmailTable();

      // Calculate date range
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      const sinceDateStr = sinceDate.toISOString().split('T')[0];

      // Get list of all folders
      log.blue('📁 Getting folder list...');
      const folders = await client.list();
      
      let totalDownloaded = 0;
      let totalFound = 0;

      // Download from each folder
      for (const folder of folders) {
        // Skip some system folders that might not contain user emails
        if (folder.path.startsWith('[') || folder.path === 'Notes') {
          log.gray(`Skipping system folder: ${folder.path}`);
          continue;
        }

        log.blue(`\n📂 Checking folder: ${folder.path}...`);
        
        try {
          const lock = await client.getMailboxLock(folder.path);
          
          try {
            // First, collect all UIDs currently on the server for this folder
            const serverUIDs = new Set();
            
            // Search for emails from the last N days in this folder
            let folderDownloaded = 0;
            let folderTotal = 0;
            
            // Use a simple fetch approach
            for await (const message of client.fetch(
              { since: sinceDate },
              { envelope: true, source: true, flags: true }
            )) {
              folderTotal++;
              totalFound++;
              serverUIDs.add(message.uid);
              
              try {
                // Check if already downloaded
                const existing = this.cache.db.prepare('SELECT id FROM emails WHERE uid = ? AND folder = ?').get(message.uid, folder.path);
                if (existing) {
                  continue;
                }

                if (message.source) {
                  // Parse the email
                  const parsed = await simpleParser(message.source);
                  
                  // Store in database
                  await this.storeEmail({
                    uid: message.uid,
                    messageId: parsed.messageId || `uid-${message.uid}-${folder.path}`,
                    from: parsed.from?.text || '',
                    to: parsed.to?.text || '',
                    subject: parsed.subject || '(no subject)',
                    date: parsed.date || new Date(),
                    headers: JSON.stringify(parsed.headerLines?.map(h => [h.key, h.line]) || []),
                    textContent: parsed.text || '',
                    htmlContent: parsed.html || '',
                    attachments: JSON.stringify(parsed.attachments?.map(a => ({
                      filename: a.filename,
                      contentType: a.contentType,
                      size: a.size
                    })) || []),
                    flags: JSON.stringify(message.flags || []),
                    size: message.source.length || 0,
                    rawSource: message.source.toString('base64'),
                    folder: folder.path
                  });
                  
                  folderDownloaded++;
                  totalDownloaded++;
                  
                  // Show progress every 10 emails per folder
                  if (folderDownloaded % 10 === 0 && !isBackground) {
                    log.green(`  Progress: ${folderDownloaded} new emails from ${folder.path}...`);
                  }
                }
              } catch (error) {
                if (!isBackground) {
                  console.error(chalk.red(`  Error processing email UID ${message.uid}:`), error.message);
                }
              }
            }

            // Sync deletions: Remove emails from local database that no longer exist on server
            // Wrap in a transaction for better performance and atomicity
            const syncDeletions = this.cache.db.transaction(() => {
              const localUIDs = this.cache.db.prepare(
                'SELECT uid FROM emails WHERE folder = ? AND date >= ?'
              ).all(folder.path, sinceDate.toISOString());
              
              let deletedCount = 0;
              const deleteStmt = this.cache.db.prepare('DELETE FROM emails WHERE uid = ? AND folder = ?');
              
              for (const localEmail of localUIDs) {
                if (!serverUIDs.has(localEmail.uid)) {
                  // Email exists locally but not on server - it was deleted
                  deleteStmt.run(localEmail.uid, folder.path);
                  deletedCount++;
                }
              }
              
              return deletedCount;
            });
            
            const deletedCount = syncDeletions();

            if (folderTotal > 0 || deletedCount > 0) {
              const parts = [];
              if (folderDownloaded > 0) parts.push(`${folderDownloaded} new`);
              if (folderTotal - folderDownloaded > 0) parts.push(`${folderTotal - folderDownloaded} cached`);
              if (deletedCount > 0) parts.push(`${deletedCount} removed`);
              log.green(`  ✓ ${folder.path}: ${parts.join(', ')}`);
            } else {
              log.gray(`  ✓ ${folder.path}: No emails from last ${days} days`);
            }

          } finally {
            lock.release();
          }
        } catch (error) {
          if (!isBackground) {
            if (!isBackground) {
              console.error(chalk.yellow(`  Could not access folder ${folder.path}: ${error.message}`));
            }
          }
        }
      }

      if (!isBackground || totalDownloaded > 0) {
        log.green(`\n✅ Total: Downloaded ${totalDownloaded} new emails across all folders`);
      }
      if (!isBackground) {
        log.gray(`Found ${totalFound} total emails from the last ${days} days`);
      }

      // Disconnect
      await client.logout();
      log.green('✅ Disconnected from email server');

    } catch (error) {
      if (!isBackground) {
        console.error(chalk.red('IMAP Error:'), error);
      }
      throw error;
    } finally {
      // Always remove lock file when done
      try {
        await fs.unlink(lockFile);
      } catch (error) {
        // Ignore errors removing lock file
      }
    }
  }

  async initializeEmailTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid INTEGER NOT NULL,
        message_id TEXT,
        from_address TEXT,
        to_address TEXT,
        subject TEXT,
        date DATETIME,
        headers TEXT,
        text_content TEXT,
        html_content TEXT,
        attachments TEXT,
        flags TEXT,
        size INTEGER,
        raw_source TEXT,
        folder TEXT DEFAULT 'INBOX',
        downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(uid, folder)
      )
    `;

    await this.cache.db.exec(createTableSQL);

    // Add folder column if it doesn't exist (for existing databases)
    try {
      await this.cache.db.exec('ALTER TABLE emails ADD COLUMN folder TEXT DEFAULT "INBOX"');
    } catch (e) {
      // Column already exists
    }

    // Create indexes
    await this.cache.db.exec('CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date)');
    await this.cache.db.exec('CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address)');
    await this.cache.db.exec('CREATE INDEX IF NOT EXISTS idx_emails_subject ON emails(subject)');
    await this.cache.db.exec('CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder)');
  }

  async storeEmail(email) {
    const stmt = this.cache.db.prepare(`
      INSERT OR REPLACE INTO emails (
        uid, message_id, from_address, to_address, subject, date,
        headers, text_content, html_content, attachments, flags, size, raw_source, folder
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      email.uid,
      email.messageId,
      email.from,
      email.to,
      email.subject,
      email.date.toISOString(),
      email.headers,
      email.textContent,
      email.htmlContent,
      email.attachments,
      email.flags,
      email.size,
      email.rawSource,
      email.folder || 'INBOX'
    );
  }

  async getEmailStats() {
    const stats = this.cache.db.prepare(`
      SELECT 
        COUNT(*) as total,
        MIN(date) as oldest,
        MAX(date) as newest,
        SUM(size) as total_size
      FROM emails
    `).get();

    // Get folder breakdown
    const folderStats = this.cache.db.prepare(`
      SELECT 
        folder,
        COUNT(*) as count
      FROM emails
      GROUP BY folder
      ORDER BY count DESC
    `).all();

    return { ...stats, folders: folderStats };
  }
}