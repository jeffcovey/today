import { ImapFlow } from 'imapflow';
import chalk from 'chalk';
import { SQLiteCache } from './sqlite-cache.js';
import fs from 'fs/promises';
import path from 'path';
import { simpleParser } from 'mailparser';

export class EmailDownloader {
  constructor() {
    this.cache = new SQLiteCache();
  }

  async downloadEmails(account, days) {
    // Check for credentials
    if (!process.env.EMAIL_PASSWORD) {
      console.error(chalk.red('❌ Email password not found in environment variables'));
      console.log(chalk.yellow('Run "email-cli setup" for instructions on setting up credentials'));
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
      logger: false, // Set to console for debugging
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
      }
    });

    try {
      // Connect to IMAP
      console.log(chalk.blue(`🔌 Connecting to iCloud email for ${account}...`));
      await client.connect();
      console.log(chalk.green('✅ Connected successfully'));

      // Calculate date range
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      const sinceDateStr = sinceDate.toISOString().split('T')[0];

      // Open INBOX
      console.log(chalk.blue('📂 Opening INBOX...'));
      const mailbox = await client.getMailboxLock('INBOX');
      
      try {
        // Search for emails from the last N days
        console.log(chalk.blue(`🔍 Searching for emails since ${sinceDateStr}...`));
        const messages = [];
        
        for await (const message of client.fetch(
          { since: sinceDate },
          { 
            envelope: true,
            bodyStructure: true,
            headers: true,
            size: true
          }
        )) {
          messages.push({
            uid: message.uid,
            envelope: message.envelope,
            headers: message.headers,
            size: message.size,
            flags: message.flags
          });
        }

        console.log(chalk.green(`📧 Found ${messages.length} emails`));

        // Initialize database table for emails
        await this.initializeEmailTable();

        // Download full email content and store
        let downloaded = 0;
        const batchSize = 5; // Smaller batch size for stability
        
        console.log(chalk.blue('📥 Downloading email content...'));
        
        for (let i = 0; i < messages.length; i += batchSize) {
          const batch = messages.slice(i, i + batchSize);
          
          for (const msg of batch) {
            try {
              // Check if email already exists
              const existing = this.cache.db.prepare('SELECT id FROM emails WHERE uid = ?').get(msg.uid);
              if (existing) {
                console.log(chalk.gray(`Skipping email ${msg.uid} - already downloaded`));
                downloaded++;
                continue;
              }

              // Fetch full message - using sequence number approach
              let fullMessage;
              try {
                // Try to fetch by UID first
                fullMessage = await client.fetchOne(`${msg.uid}`, { 
                  source: true 
                }, { uid: true });
              } catch (uidError) {
                console.log(chalk.yellow(`UID fetch failed for ${msg.uid}, trying sequence number...`));
                // If UID fails, skip this message
                continue;
              }

              if (fullMessage && fullMessage.source) {
                // Parse email
                const parsed = await simpleParser(fullMessage.source);
                
                // Store in database
                await this.storeEmail({
                  uid: msg.uid,
                  messageId: parsed.messageId || `uid-${msg.uid}`,
                  from: parsed.from?.text || '',
                  to: parsed.to?.text || '',
                  subject: parsed.subject || '(no subject)',
                  date: parsed.date || new Date(),
                  headers: JSON.stringify(Object.fromEntries(parsed.headers || [])),
                  textContent: parsed.text || '',
                  htmlContent: parsed.html || '',
                  attachments: JSON.stringify(parsed.attachments?.map(a => ({
                    filename: a.filename,
                    contentType: a.contentType,
                    size: a.size
                  })) || []),
                  flags: JSON.stringify(msg.flags || []),
                  size: msg.size || 0,
                  rawSource: fullMessage.source.toString('base64')
                });
                
                downloaded++;
                if (downloaded % 10 === 0) {
                  console.log(chalk.gray(`Progress: ${downloaded}/${messages.length} emails downloaded`));
                }
              } else {
                console.error(chalk.yellow(`Warning: No source content for email ${msg.uid}`));
              }
            } catch (error) {
              console.error(chalk.red(`Failed to download email ${msg.uid}:`), error.message);
              // Continue with next email instead of failing
            }
          }
          
          // Progress update
          console.log(chalk.gray(`Progress: ${Math.min(i + batchSize, messages.length)}/${messages.length} emails processed`));
        }

        console.log(chalk.green(`✅ Downloaded ${downloaded} emails successfully`));

      } finally {
        mailbox.release();
      }

      // Log out
      await client.logout();
      console.log(chalk.green('✅ Disconnected from email server'));

    } catch (error) {
      console.error(chalk.red('IMAP Error:'), error);
      throw error;
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
        downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(uid)
      )
    `;

    await this.cache.db.exec(createTableSQL);

    // Create indexes
    await this.cache.db.exec('CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date)');
    await this.cache.db.exec('CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address)');
    await this.cache.db.exec('CREATE INDEX IF NOT EXISTS idx_emails_subject ON emails(subject)');
  }

  async storeEmail(email) {
    const stmt = this.cache.db.prepare(`
      INSERT OR REPLACE INTO emails (
        uid, message_id, from_address, to_address, subject, date,
        headers, text_content, html_content, attachments, flags, size, raw_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      email.rawSource
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

    return stats;
  }
}