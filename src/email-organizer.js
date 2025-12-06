import { ImapFlow } from 'imapflow';
import chalk from 'chalk';
import { SQLiteCache } from './sqlite-cache.js';

const FOLDERS = {
  FRONT_STAGE: '_Front Stage',
  BACK_STAGE: '_Back Stage',
  OFF_STAGE: '_Off Stage'
};

// Categorization rules
const CATEGORIZATION_RULES = {
  [FOLDERS.FRONT_STAGE]: {
    // Front Stage: Meetings, calls, support, emails, communications
    patterns: [
      'help@oldergay.men', // Customer support
      'no-reply@supportmessaging.airbnb.com', // Airbnb communications
      'express@airbnb.com',
      '@mail.beehiiv.com', // Newsletters
      '@patreon.com', // Patreon communications
      'bingo@patreon.com',
      '@email.patreon.com', // Patreon notifications
      '@oldergay.discoursemail.com', // OGM discussion notifications
      '@facebookmail.com', // Facebook group notifications
      'automated@airbnb.com' // Airbnb messages
    ],
    keywords: ['meeting', 'call', 'support', 'reply', 'message from', 'new reply']
  },
  [FOLDERS.BACK_STAGE]: {
    // Back Stage: Maintenance, bills, bug fixes, organizing
    patterns: [
      'no.reply.alerts@chase.com', // Bank alerts
      '@healthchecks.io', // System health monitoring
      'noreply@notify.cloudflare.com', // Infrastructure alerts
      'alerts@mail.zapier.com', // Automation alerts
      '@sentry.io', // Error monitoring
      '@github.com', // GitHub notifications
      'notifications@github.com',
      'dependabot',
      'github-actions',
      '@noreply.fpl.com', // FPL electric bill
      '@memberdoc.com', // Florida Blue insurance
      '@mbr.floridablue.com', // Florida Blue
      '@servicetitan.com', // Service providers (plumber, etc)
      '@conduent.com', // FundVantage Trust (financial)
      'no-reply@asana.com', // Asana project management
      'google-maps-platform-noreply@google.com', // Google Maps API
      '@md.getsentry.com', // Sentry error monitoring
      '@rxorder.walgreens.com', // Walgreens pharmacy
      'noreply@email.apple.com', // Apple security notifications
      'no-reply@zoom.us', // Zoom security notifications
      '@sedo.com', // Domain registrar
      '@heroku.com', // Heroku bills and notifications
      'noreply@heroku.com'
    ],
    keywords: ['payment', 'bill', 'invoice', 'alert', 'error', 'failed', 'down', 'maintenance', 'statement', 'account']
  },
  [FOLDERS.OFF_STAGE]: {
    // Off Stage: Personal time, nature, friends, reading, entertainment
    patterns: [
      '@amazon.com', // Amazon/shopping
      '@email.apple.com', // Apple receipts
      '@e.dsw.com', // Shopping
      '@jacquielawson.com', // Personal ecards
      '@scandigital.com', // Personal projects
      'store-news@amazon.com',
      'store_news@amazon.com',
      '@email.meetup.com', // Meetup social events
      '@wildapricot.org', // Social organizations
      '@wordpress.com', // Blog subscriptions
      '@gmail.com', // Personal emails (most common)
      '@hotmail.co.uk', // Personal emails
      'noreply_at_email_browardcenter_org', // Entertainment venues
      '@email.trustedhousesitters.com', // Travel/housesitting
      'ptww.convention.committee@gmail.com' // Prime Timers events
    ],
    keywords: ['book', 'deal', 'sale', 'ecard', 'recipe', 'travel', 'meetup', 'event']
  }
};

export class EmailOrganizer {
  constructor() {
    this.cache = new SQLiteCache();
    this.client = null;
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
    console.log(chalk.green('✅ Connected to iCloud IMAP'));
  }

  async disconnect() {
    if (this.client) {
      await this.client.logout();
      console.log(chalk.green('✅ Disconnected'));
    }
  }

  async createFolders() {
    console.log(chalk.blue('\n📁 Creating stage folders...'));

    for (const folder of Object.values(FOLDERS)) {
      try {
        // Check if folder already exists
        const list = await this.client.list();
        const exists = list.some(f => f.path === folder);

        if (exists) {
          console.log(chalk.gray(`  ✓ ${folder} already exists`));
        } else {
          await this.client.mailboxCreate(folder);
          console.log(chalk.green(`  ✓ Created ${folder}`));
        }
      } catch (error) {
        if (error.message.includes('already exists')) {
          console.log(chalk.gray(`  ✓ ${folder} already exists`));
        } else {
          console.log(chalk.yellow(`  ⚠ Could not create ${folder}: ${error.message}`));
        }
      }
    }
  }

  categorizeEmail(email) {
    const from = email.from_address?.toLowerCase() || '';
    const subject = email.subject?.toLowerCase() || '';

    // First check Front Stage (highest priority - work/support)
    const frontRules = CATEGORIZATION_RULES[FOLDERS.FRONT_STAGE];
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
    const backRules = CATEGORIZATION_RULES[FOLDERS.BACK_STAGE];
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
    const offRules = CATEGORIZATION_RULES[FOLDERS.OFF_STAGE];
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
    console.log(chalk.blue('\n📧 Categorizing inbox emails...'));

    // Get all emails from INBOX in local database
    const emails = this.cache.db.prepare(`
      SELECT * FROM emails
      WHERE folder = 'INBOX'
      ORDER BY date DESC
    `).all();

    console.log(chalk.gray(`Found ${emails.length} emails in INBOX`));

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
    console.log(chalk.blue('\n📊 Categorization summary:'));
    for (const [folder, uids] of Object.entries(moveGroups)) {
      if (uids.length > 0) {
        console.log(chalk.cyan(`  ${folder}: ${uids.length} emails`));
      }
    }

    const totalToMove = Object.values(moveGroups).reduce((sum, arr) => sum + arr.length, 0);
    console.log(chalk.gray(`  Remaining in INBOX: ${emails.length - totalToMove} emails`));

    // Move emails
    if (totalToMove > 0) {
      console.log(chalk.blue('\n📦 Moving emails to stage folders...'));

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

              console.log(chalk.green(`  ✓ Moved ${batch.length} emails to ${folder} (${i + batch.length}/${uids.length})`));
            }
          }
        }
      } finally {
        lock.release();
      }

      console.log(chalk.green(`\n✅ Successfully organized ${totalToMove} emails into stage folders`));
    } else {
      console.log(chalk.yellow('\n⚠ No emails matched categorization rules'));
    }
  }

  async run() {
    try {
      await this.connect();
      await this.createFolders();
      await this.organizeInbox();
      await this.disconnect();
    } catch (error) {
      console.error(chalk.red('Error:'), error.message);
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
