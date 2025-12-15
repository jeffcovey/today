import { ImapFlow } from 'imapflow';
import { colors } from './cli-utils.js';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SQLiteCache } from './sqlite-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FOLDERS = {
  FRONT_STAGE: '_Front Stage',
  BACK_STAGE: '_Back Stage',
  OFF_STAGE: '_Off Stage'
};

// Load email patterns from config.toml
function loadEmailPatterns() {
  const getConfigPath = join(__dirname, '..', 'bin', 'get-config');

  const patterns = {
    front_stage: [],
    back_stage: [],
    off_stage: []
  };

  for (const stage of ['front_stage', 'back_stage', 'off_stage']) {
    try {
      const result = execSync(`"${getConfigPath}" email.${stage}.patterns`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const parsed = JSON.parse(result.trim());
      if (Array.isArray(parsed)) {
        patterns[stage] = parsed;
      }
    } catch {
      // No patterns configured for this stage
    }
  }

  return patterns;
}

// Build categorization rules from config
function buildCategorizationRules() {
  const patterns = loadEmailPatterns();

  return {
    [FOLDERS.FRONT_STAGE]: {
      patterns: patterns.front_stage,
      keywords: ['meeting', 'call', 'support', 'reply', 'message from', 'new reply']
    },
    [FOLDERS.BACK_STAGE]: {
      patterns: patterns.back_stage,
      keywords: ['payment', 'bill', 'invoice', 'alert', 'error', 'failed', 'down', 'maintenance', 'statement', 'account']
    },
    [FOLDERS.OFF_STAGE]: {
      patterns: patterns.off_stage,
      keywords: ['book', 'deal', 'sale', 'ecard', 'recipe', 'travel', 'meetup', 'event']
    }
  };
}

export class EmailOrganizer {
  constructor() {
    this.cache = new SQLiteCache();
    this.client = null;
    this.categorizationRules = buildCategorizationRules();
  }

  async connect() {
    if (!process.env.EMAIL_PASSWORD || !process.env.EMAIL_ACCOUNT) {
      throw new Error('EMAIL_PASSWORD and EMAIL_ACCOUNT must be set in environment');
    }

    this.client = new ImapFlow({
      host: 'imap.mail.me.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.EMAIL_ACCOUNT,
        pass: process.env.EMAIL_PASSWORD
      },
      logger: false
    });

    await this.client.connect();
    console.log(colors.green('✅ Connected to iCloud IMAP'));
  }

  async disconnect() {
    if (this.client) {
      await this.client.logout();
      console.log(colors.green('✅ Disconnected'));
    }
  }

  async createFolders() {
    console.log(colors.blue('\n📁 Creating stage folders...'));

    for (const folder of Object.values(FOLDERS)) {
      try {
        // Check if folder already exists
        const list = await this.client.list();
        const exists = list.some(f => f.path === folder);

        if (exists) {
          console.log(colors.gray(`  ✓ ${folder} already exists`));
        } else {
          await this.client.mailboxCreate(folder);
          console.log(colors.green(`  ✓ Created ${folder}`));
        }
      } catch (error) {
        if (error.message.includes('already exists')) {
          console.log(colors.gray(`  ✓ ${folder} already exists`));
        } else {
          console.log(colors.yellow(`  ⚠ Could not create ${folder}: ${error.message}`));
        }
      }
    }
  }

  categorizeEmail(email) {
    const from = email.from_address?.toLowerCase() || '';
    const subject = email.subject?.toLowerCase() || '';

    // First check Front Stage (highest priority - work/support)
    const frontRules = this.categorizationRules[FOLDERS.FRONT_STAGE];
    if (frontRules.patterns) {
      for (const pattern of frontRules.patterns) {
        if (from.includes(pattern.toLowerCase())) {
          return FOLDERS.FRONT_STAGE;
        }
      }
    }
    if (frontRules.keywords) {
      for (const keyword of frontRules.keywords) {
        if (subject.includes(keyword.toLowerCase())) {
          return FOLDERS.FRONT_STAGE;
        }
      }
    }

    // Then check Back Stage (system/financial)
    const backRules = this.categorizationRules[FOLDERS.BACK_STAGE];
    if (backRules.patterns) {
      for (const pattern of backRules.patterns) {
        if (from.includes(pattern.toLowerCase())) {
          return FOLDERS.BACK_STAGE;
        }
      }
    }
    if (backRules.keywords) {
      for (const keyword of backRules.keywords) {
        if (subject.includes(keyword.toLowerCase())) {
          return FOLDERS.BACK_STAGE;
        }
      }
    }

    // Then check Off Stage patterns explicitly (before automated/marketing check)
    const offRules = this.categorizationRules[FOLDERS.OFF_STAGE];
    if (offRules.patterns) {
      for (const pattern of offRules.patterns) {
        if (from.includes(pattern.toLowerCase())) {
          return FOLDERS.OFF_STAGE;
        }
      }
    }
    if (offRules.keywords) {
      for (const keyword of offRules.keywords) {
        if (subject.includes(keyword.toLowerCase())) {
          return FOLDERS.OFF_STAGE;
        }
      }
    }

    // Check if it's automated/service email (keep in INBOX for review)
    const automatedPatterns = [
      'noreply', 'no-reply', 'donotreply', 'do-not-reply',
      'automated', 'notification', 'mailer-daemon'
    ];
    const isAutomated = automatedPatterns.some(pattern => from.includes(pattern));

    // Check if it's marketing/newsletter (keep in INBOX for review)
    const marketingPatterns = [
      'newsletter', 'marketing', 'promo', 'offer', 'deals', 'sale',
      'unsubscribe'
    ];
    const isMarketing = marketingPatterns.some(pattern =>
      from.includes(pattern) || subject.includes(pattern)
    );

    // If it's not automated or marketing, treat as personal correspondence -> Off Stage
    if (!isAutomated && !isMarketing) {
      return FOLDERS.OFF_STAGE;
    }

    // Default: leave automated/marketing in INBOX for manual review
    return null;
  }

  async organizeInbox() {
    console.log(colors.blue('\n📧 Categorizing inbox emails...'));

    // Get all emails from INBOX in local database
    const emails = this.cache.db.prepare(`
      SELECT * FROM email
      WHERE folder = 'INBOX'
      ORDER BY date DESC
    `).all();

    console.log(colors.gray(`Found ${emails.length} emails in INBOX`));

    // Group emails by target folder
    const moveGroups = {
      [FOLDERS.FRONT_STAGE]: [],
      [FOLDERS.BACK_STAGE]: [],
      [FOLDERS.OFF_STAGE]: []
    };

    for (const email of emails) {
      const targetFolder = this.categorizeEmail(email);
      if (targetFolder) {
        moveGroups[targetFolder].push(email.uid);
      }
    }

    // Show summary
    console.log(colors.blue('\n📊 Categorization summary:'));
    for (const [folder, uids] of Object.entries(moveGroups)) {
      if (uids.length > 0) {
        console.log(colors.cyan(`  ${folder}: ${uids.length} emails`));
      }
    }

    const totalToMove = Object.values(moveGroups).reduce((sum, arr) => sum + arr.length, 0);
    console.log(colors.gray(`  Remaining in INBOX: ${emails.length - totalToMove} emails`));

    // Move emails
    if (totalToMove > 0) {
      console.log(colors.blue('\n📦 Moving emails to stage folders...'));

      const lock = await this.client.getMailboxLock('INBOX');
      try {
        for (const [folder, uids] of Object.entries(moveGroups)) {
          if (uids.length > 0) {
            // Move in batches of 50
            for (let i = 0; i < uids.length; i += 50) {
              const batch = uids.slice(i, i + 50);
              await this.client.messageMove(batch, folder, { uid: true });

              // Update local database
              const stmt = this.cache.db.prepare('UPDATE emails SET folder = ? WHERE uid = ? AND folder = ?');
              for (const uid of batch) {
                stmt.run(folder, uid, 'INBOX');
              }

              console.log(colors.green(`  ✓ Moved ${batch.length} emails to ${folder} (${i + batch.length}/${uids.length})`));
            }
          }
        }
      } finally {
        lock.release();
      }

      console.log(colors.green(`\n✅ Successfully organized ${totalToMove} emails into stage folders`));
    } else {
      console.log(colors.yellow('\n⚠ No emails matched categorization rules'));
    }
  }

  async run() {
    try {
      await this.connect();
      await this.createFolders();
      await this.organizeInbox();
      await this.disconnect();
    } catch (error) {
      console.error(colors.red('Error:'), error.message);
      console.error(error.stack);
      throw error;
    } finally {
      // Close the database connection
      if (this.cache && this.cache.db) {
        this.cache.db.close();
      }
    }
  }
}
