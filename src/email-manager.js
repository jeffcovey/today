import { ImapFlow } from 'imapflow';
import chalk from 'chalk';
import { SQLiteCache } from './sqlite-cache.js';
import { NaturalLanguageSearch } from './natural-language-search.js';
import inquirer from 'inquirer';
import readline from 'readline';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export class EmailManager {
  constructor() {
    this.cache = new SQLiteCache();
    this.nlSearch = new NaturalLanguageSearch();
    this.client = null;
    this.inConversationMode = false;
  }

  async connect(account) {
    if (!process.env.EMAIL_PASSWORD) {
      throw new Error('EMAIL_PASSWORD not configured');
    }

    this.client = new ImapFlow({
      host: 'imap.mail.me.com',
      port: 993,
      secure: true,
      auth: {
        user: account,
        pass: process.env.EMAIL_PASSWORD
      },
      logger: false
    });

    await this.client.connect();
    console.log(chalk.green('✅ Connected to email server'));
  }

  async disconnect() {
    if (this.client) {
      await this.client.logout();
      console.log(chalk.green('✅ Disconnected from email server'));
    }
  }

  // Get emails from local database
  async getLocalEmails(filter = {}) {
    let query = 'SELECT * FROM email';
    const conditions = [];
    const params = [];

    // By default, exclude emails in trash folders unless specifically requested
    if (!filter.includeTrash && !filter.folder) {
      conditions.push('folder NOT IN (?, ?, ?)');
      params.push('Trash', 'Deleted Messages', 'Deleted Items');
    }

    if (filter.from) {
      conditions.push('from_address LIKE ?');
      params.push(`%${filter.from}%`);
    }
    if (filter.subject) {
      conditions.push('subject LIKE ?');
      params.push(`%${filter.subject}%`);
    }
    if (filter.content) {
      // Search in both subject and from_address fields
      conditions.push('(subject LIKE ? OR from_address LIKE ?)');
      params.push(`%${filter.content}%`, `%${filter.content}%`);
    }
    if (filter.since) {
      conditions.push('date >= ?');
      params.push(filter.since.toISOString());
    }
    if (filter.before) {
      conditions.push('date <= ?');
      params.push(filter.before.toISOString());
    }
    if (filter.folder) {
      conditions.push('folder = ?');
      params.push(filter.folder);
    }
    if (filter.excludeTypes && filter.excludeTypes.length > 0) {
      // Exclude common newsletter/advertisement patterns
      const exclusions = [];
      
      if (filter.excludeTypes.includes('newsletters')) {
        exclusions.push('from_address NOT LIKE ?');
        params.push('%newsletter%');
        exclusions.push('from_address NOT LIKE ?');
        params.push('%marketing%');
        exclusions.push('from_address NOT LIKE ?');
        params.push('%news%');
        exclusions.push('subject NOT LIKE ?');
        params.push('%newsletter%');
        exclusions.push('subject NOT LIKE ?');
        params.push('%unsubscribe%');
      }
      
      if (filter.excludeTypes.includes('advertisements')) {
        exclusions.push('from_address NOT LIKE ?');
        params.push('%promo%');
        exclusions.push('from_address NOT LIKE ?');
        params.push('%offer%');
        exclusions.push('from_address NOT LIKE ?');
        params.push('%deals%');
        exclusions.push('from_address NOT LIKE ?');
        params.push('%sale%');
        exclusions.push('subject NOT LIKE ?');
        params.push('%sale%');
        exclusions.push('subject NOT LIKE ?');
        params.push('% off %');
      }
      
      if (filter.excludeTypes.includes('automated')) {
        exclusions.push('from_address NOT LIKE ?');
        params.push('%noreply%');
        exclusions.push('from_address NOT LIKE ?');
        params.push('%no-reply%');
        exclusions.push('from_address NOT LIKE ?');
        params.push('%donotreply%');
        exclusions.push('from_address NOT LIKE ?');
        params.push('%alerts%');
        exclusions.push('from_address NOT LIKE ?');
        params.push('%notification%');
        exclusions.push('subject NOT LIKE ?');
        params.push('%[MISSING]%');
        exclusions.push('subject NOT LIKE ?');
        params.push('%[REPORTING]%');
      }
      
      if (exclusions.length > 0) {
        conditions.push(`(${exclusions.join(' AND ')})`);
      }
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY date DESC';
    
    if (filter.limit) {
      query += ' LIMIT ?';
      params.push(filter.limit);
    }

    return this.cache.db.prepare(query).all(...params);
  }

  // Get list of folders from IMAP
  async getFolders() {
    if (!this.client) {
      throw new Error('Not connected to email server');
    }

    try {
      const list = await this.client.list();
      const folders = [];
      
      for (const folder of list) {
        folders.push({
          path: folder.path,
          name: folder.name,
          specialUse: folder.specialUse,
          delimiter: folder.delimiter
        });
      }
      
      return folders;
    } catch (error) {
      console.error('Error listing folders:', error);
      // Return default folders for iCloud
      return [
        { path: 'INBOX', name: 'INBOX' },
        { path: 'Trash', name: 'Trash' },
        { path: 'Sent', name: 'Sent' },
        { path: 'Drafts', name: 'Drafts' },
        { path: 'Junk', name: 'Junk' }
      ];
    }
  }

  // Move emails to a folder
  async moveEmails(uids, targetFolder) {
    return this.moveEmailsFromFolder(uids, 'INBOX', targetFolder);
  }

  // Move emails from a specific folder to another folder
  async moveEmailsFromFolder(uids, sourceFolder, targetFolder) {
    if (!this.client) {
      throw new Error('Not connected to email server');
    }

    const lock = await this.client.getMailboxLock(sourceFolder);
    try {
      // Move messages
      await this.client.messageMove(uids, targetFolder, { uid: true });
      console.log(chalk.green(`✅ Moved ${uids.length} emails to ${targetFolder}`));

      // Update local database to reflect the move
      try {
        const stmt = this.cache.db.prepare('UPDATE emails SET folder = ? WHERE uid = ? AND folder = ?');
        for (const uid of uids) {
          // Update the folder column to reflect where the email now lives
          stmt.run(targetFolder, uid, sourceFolder);
        }
      } catch (dbError) {
        // Don't throw the error - the move succeeded, this is just local bookkeeping
        console.log(chalk.yellow(`Note: Could not update local cache: ${dbError.message}`));
      }
    } finally {
      lock.release();
    }
  }

  // Delete emails (move to trash)
  async deleteEmails(uids) {
    return this.deleteEmailsFromFolder(uids, 'INBOX');
  }

  // Delete emails from a specific folder
  async deleteEmailsFromFolder(uids, sourceFolder) {
    // First, let's check what folders are available
    const folders = await this.getFolders();
    const trashFolder = folders.find(f => 
      f.specialUse === '\\Trash' || 
      (Array.isArray(f.specialUse) && f.specialUse.includes('\\Trash')) ||
      f.path.toLowerCase() === 'trash' ||
      f.path === 'Deleted Messages' // Common on iCloud
    );
    
    const trashPath = trashFolder ? trashFolder.path : 'Trash';
    
    try {
      await this.moveEmailsFromFolder(uids, sourceFolder, trashPath);
    } catch (error) {
      // If move fails, try marking as deleted
      console.log(chalk.yellow(`Could not move to ${trashPath}: ${error.message}`));
      console.log(chalk.yellow('Marking as deleted instead...'));
      const lock = await this.client.getMailboxLock(sourceFolder);
      try {
        await this.client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
        console.log(chalk.green(`✅ Marked ${uids.length} emails as deleted`));
      } finally {
        lock.release();
      }
    }
  }

  // Natural language conversation about emails
  async conversationMode() {
    this.inConversationMode = true;

    console.log(chalk.blue('\n💬 Email Conversation Mode'));
    console.log(chalk.gray('Ask questions about your emails or request actions.'));
    console.log(chalk.gray('Type "exit" to return to main menu.'));
    console.log(chalk.gray('Use ↑↓ arrow keys to navigate command history.\n'));

    // Check if we're in an interactive terminal
    const isInteractive = process.stdin.isTTY;

    // Start background download only in interactive mode
    if (isInteractive) {
      this.startBackgroundDownload();
    }

    // Setup readline interface with history
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.blue('You: '),
      historySize: 100,
      removeHistoryDuplicates: true,
      terminal: true  // Ensure terminal mode is enabled for arrow keys
    });

    // Store reference to readline for restoration after inquirer
    this.currentReadline = rl;

    // Load command history from file
    const historyFile = path.join(os.homedir(), '.email-cli-history');
    const commandHistory = [];
    
    try {
      const historyData = await fs.readFile(historyFile, 'utf8');
      const lines = historyData.split('\n').filter(line => line.trim());
      // Add to commandHistory in file order (oldest first)
      lines.forEach(line => {
        commandHistory.push(line);
      });
      // Add to readline history in reverse order (newest first for up arrow)
      lines.reverse().forEach(line => {
        rl.history.push(line);
      });
    } catch (error) {
      // History file doesn't exist yet, that's okay
    }

    // Setup event handlers
    const processQuery = async (query) => {
      if (!query || query.trim().length === 0) {
        rl.prompt();
        return;
      }

      if (query.toLowerCase() === 'exit') {
        // Save history before exiting
        try {
          await fs.writeFile(historyFile, commandHistory.join('\n'));
          console.log(chalk.gray(`Saved ${commandHistory.length} commands to history`));
        } catch (error) {
          console.error(chalk.red('Error saving history:'), error.message);
        }
        rl.close();
        return;
      }

      // Add to history if not duplicate of last command
      if (commandHistory.length === 0 || commandHistory[commandHistory.length - 1] !== query) {
        commandHistory.push(query);
        if (commandHistory.length > 100) {
          commandHistory.shift(); // Keep only last 100 commands
        }
      }

      try {
        // Temporarily pause the readline interface during async operations
        rl.pause();
        await this.handleConversation(query);
      } catch (error) {
        console.error(chalk.red('Error:'), error.message);
        console.error(chalk.gray('Stack trace:'), error.stack);
      } finally {
        // Resume the readline interface
        if (!rl.closed) {
          rl.resume();
          rl.prompt();
        } else {
          console.log(chalk.yellow('Readline interface was closed unexpectedly'));
        }
      }
    };

    // Handle line input
    rl.on('line', (line) => {
      processQuery(line).catch(error => {
        console.error(chalk.red('Query processing error:'), error.message);
        rl.prompt();
      });
    });

    // Handle errors
    rl.on('error', (error) => {
      console.error(chalk.red('Readline error:'), error.message);
      if (!rl.closed) {
        rl.prompt();
      }
    });

    // Create a promise that will resolve when the interface closes
    const closePromise = new Promise(resolve => {
      rl.on('close', async () => {
        console.log(chalk.gray('\nExiting conversation mode...'));
        // Save history on any close event (including Ctrl+C)
        try {
          await fs.writeFile(historyFile, commandHistory.join('\n'));
        } catch (error) {
          // Ignore history save errors
        }
        resolve();
      });
    });

    // Save history on process exit signals
    const saveHistory = async () => {
      try {
        await fs.writeFile(historyFile, commandHistory.join('\n'));
      } catch (error) {
        // Ignore history save errors
      }
    };

    // Handle SIGINT (Ctrl+C) gracefully
    rl.on('SIGINT', async () => {
      console.log(chalk.gray('\n\nExiting...'));
      await saveHistory();
      rl.close();
    });

    // Start the prompt
    rl.prompt();

    // Wait for the interface to close
    await closePromise;

    // Clean up
    this.inConversationMode = false;
    this.currentReadline = null;
  }

  // Helper method to restore readline after inquirer prompts
  async restoreReadlineAfterInquirer() {
    if (!this.currentReadline || !process.stdin.isTTY) {
      return;
    }

    // Clear any buffered input
    while (process.stdin.read() !== null) {
      // Keep reading until buffer is empty
    }

    // Inquirer leaves stdin in a weird state, restore it for readline
    if (typeof process.stdin.setRawMode === 'function') {
      // First disable raw mode completely
      process.stdin.setRawMode(false);

      // Small delay to let the terminal settle
      await new Promise(resolve => setTimeout(resolve, 50));

      // Re-enable terminal mode for readline (this is what readline expects)
      // Readline will manage raw mode itself when needed
      process.stdin.resume();
    }

    // Give readline a moment to re-establish control
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  async handleConversation(query) {
    const lowerQuery = query.toLowerCase();

    // Handle simple count queries - but only if it's JUST asking for a count with no filters
    if ((lowerQuery === 'how many' || lowerQuery === 'count' || lowerQuery === 'how many emails') &&
        !lowerQuery.includes('from') && !lowerQuery.includes('with') && !lowerQuery.includes('contain')) {
      const emails = await this.getLocalEmails({
        folder: 'INBOX',
        limit: 10000
      });
      console.log(chalk.blue(`\n📊 You have ${emails.length} emails in your INBOX\n`));
      return;
    }

    // Handle archive commands directly
    if (lowerQuery.startsWith('archive') || lowerQuery.includes('archive all')) {
      // Extract email address or sender from query
      const fromMatch = lowerQuery.match(/from\s+([^\s]+)/i) ||
                        lowerQuery.match(/messages from\s+([^\s]+)/i) ||
                        lowerQuery.match(/emails from\s+([^\s]+)/i);

      if (fromMatch) {
        const fromAddress = fromMatch[1];
        const emails = await this.getLocalEmails({
          from: fromAddress,
          limit: 1000
        });

        if (emails.length === 0) {
          console.log(chalk.yellow(`No emails found from ${fromAddress}`));
          return;
        }

        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Archive ${emails.length} emails from ${fromAddress}?`,
          default: false
        }]);

        if (confirm) {
          await this.connect(process.env.EMAIL_ACCOUNT);

          // Group by folder
          const byFolder = {};
          emails.forEach(email => {
            const folder = email.folder || 'INBOX';
            if (!byFolder[folder]) byFolder[folder] = [];
            byFolder[folder].push(email.uid);
          });

          // Move to Archive folder
          for (const [folder, uids] of Object.entries(byFolder)) {
            await this.moveEmailsFromFolder(uids, folder, 'Archive');
          }

          await this.disconnect();
          console.log(chalk.green(`✅ Successfully archived ${emails.length} emails\n`));
        }

        // Restore readline after inquirer
        await this.restoreReadlineAfterInquirer();
        return;
      }
    }

    // Handle "delete these" with specific subjects
    if (lowerQuery.startsWith('delete these:') || (lowerQuery.includes('delete these') && query.includes(':'))) {
      // Extract the subjects from the query
      const colonIndex = query.indexOf(':');
      const subjectsText = colonIndex > -1 ? query.substring(colonIndex + 1).trim() : '';

      // Parse the subjects - they might be quoted or comma/newline separated
      const subjects = subjectsText
        .split(/[,\n]/)
        .map(s => s.trim().replace(/^["']|["']$/g, '')) // Remove quotes
        .filter(s => s.length > 0);

      if (subjects.length === 0) {
        console.log(chalk.yellow('No email subjects specified'));
        return;
      }

      console.log(chalk.gray(`Looking for emails with subjects: ${subjects.join(', ')}...`));

      // Get all recent emails to search through
      const allEmails = await this.getLocalEmails({
        folder: 'INBOX',
        limit: 1000
      });

      // Find emails matching the specified subjects
      const matchingEmails = allEmails.filter(email => {
        if (!email.subject) return false;
        return subjects.some(subject =>
          email.subject.toLowerCase().includes(subject.toLowerCase())
        );
      });

      if (matchingEmails.length === 0) {
        console.log(chalk.yellow('No emails found matching those subjects'));
        return;
      }

      console.log(chalk.blue(`\nFound ${matchingEmails.length} emails to delete:`));
      matchingEmails.forEach(email => {
        console.log(`  • ${email.subject}`);
      });

      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: chalk.red(`⚠️  Delete these ${matchingEmails.length} emails?`),
        default: false
      }]);

      if (confirm) {
        try {
          await this.connect(process.env.EMAIL_ACCOUNT);
          console.log(chalk.yellow(`Deleting ${matchingEmails.length} emails...`));

          const uids = matchingEmails.map(e => e.uid).filter(uid => uid);
          if (uids.length > 0) {
            await this.deleteEmails(uids);
            console.log(chalk.green(`✅ Deleted ${uids.length} emails\n`));
          }

          await this.disconnect();
        } catch (error) {
          console.error(chalk.red('Error deleting emails:'), error.message);
        }
      } else {
        console.log(chalk.gray('Deletion cancelled\n'));
      }

      // Restore readline after inquirer
      await this.restoreReadlineAfterInquirer();
      return;
    }

    // Handle delete commands directly
    if (lowerQuery.startsWith('delete') || lowerQuery.includes('delete all') || lowerQuery.includes('remove')) {
      // Extract email address or sender from query
      const fromMatch = lowerQuery.match(/from\s+([^\s]+@[^\s]+)/i) ||
                        lowerQuery.match(/messages from\s+([^\s]+)/i) ||
                        lowerQuery.match(/emails from\s+([^\s]+)/i);

      if (fromMatch) {
        const fromAddress = fromMatch[1];
        const emails = await this.getLocalEmails({
          from: fromAddress,
          limit: 1000
        });

        if (emails.length === 0) {
          console.log(chalk.yellow(`No emails found from ${fromAddress}`));
          return;
        }

        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Delete ${emails.length} emails from ${fromAddress}?`,
          default: false
        }]);

        if (confirm) {
          await this.connect(process.env.EMAIL_ACCOUNT);

          // Group by folder
          const byFolder = {};
          emails.forEach(email => {
            const folder = email.folder || 'INBOX';
            if (!byFolder[folder]) byFolder[folder] = [];
            byFolder[folder].push(email.uid);
          });

          // Delete from each folder
          for (const [folder, uids] of Object.entries(byFolder)) {
            await this.deleteEmailsFromFolder(uids, folder);
          }

          await this.disconnect();
          console.log(chalk.green(`✅ Successfully deleted ${emails.length} emails\n`));
        }

        // Restore readline after inquirer
        await this.restoreReadlineAfterInquirer();
        return;
      }
    }

    // Handle "show subjects" or "list subjects" queries
    if ((lowerQuery.includes('show') || lowerQuery.includes('list')) && lowerQuery.includes('subject')) {
      // Extract sender if mentioned - look for email addresses or domain patterns
      const fromMatch = lowerQuery.match(/from\s+([^\s]+@[^\s]+)/i) ||  // Full email
                       lowerQuery.match(/from\s+([^\s]+\.[^\s]+)/i) ||   // Domain
                       lowerQuery.match(/from\s+(\S+)$/i);                // Last word after "from"
      let emails;

      if (fromMatch) {
        const sender = fromMatch[1];
        emails = await this.getLocalEmails({
          from: sender,
          limit: 50
        });

        if (emails.length === 0) {
          console.log(chalk.yellow(`No emails found from ${sender}`));
          return;
        }

        console.log(chalk.green(`\n📧 Subjects of emails from ${sender}:\n`));
      } else {
        emails = await this.getLocalEmails({ limit: 20 });
        console.log(chalk.green(`\n📧 Recent email subjects:\n`));
      }

      emails.forEach((email, i) => {
        const date = new Date(email.date).toLocaleDateString();
        const subject = email.subject || '(no subject)';
        const from = email.from_name || email.from_address;
        console.log(`${i + 1}. ${chalk.bold(subject)}`);
        console.log(`   From: ${chalk.gray(from)} | Date: ${date}\n`);
      });

      return;
    }

    // Handle "emails from" queries directly
    if (lowerQuery.includes('email from') || lowerQuery.includes('emails from') || lowerQuery.includes('mail from') || lowerQuery.includes('messages from')) {
      // Extract sender from query
      const fromMatch = lowerQuery.match(/from\s+([^\s]+)/i);

      if (fromMatch) {
        const sender = fromMatch[1];
        const emails = await this.getLocalEmails({
          from: sender,
          limit: 20
        });

        if (emails.length === 0) {
          console.log(chalk.yellow(`No emails found from ${sender}`));
          return;
        }

        console.log(chalk.green(`\n📧 Found ${emails.length} emails from ${sender}:\n`));

        emails.forEach((email, i) => {
          const date = new Date(email.date).toLocaleDateString();
          const subject = email.subject || '(no subject)';

          console.log(`${i + 1}. ${chalk.bold(subject)}`);
          console.log(`   Date: ${date}\n`);
        });

        return;
      }
    }

    // Handle "most messages" or "top senders" queries
    if (lowerQuery.includes('most message') || lowerQuery.includes('most email') ||
        lowerQuery.includes('top sender') || lowerQuery.includes('sent the most')) {
      const emails = await this.getLocalEmails({
        folder: 'INBOX',
        limit: 10000
      });

      // Count emails per sender
      const senderCounts = new Map();
      emails.forEach(email => {
        const key = `${email.from_name || email.from_address}|||${email.from_address}`;
        senderCounts.set(key, (senderCounts.get(key) || 0) + 1);
      });

      // Sort by count
      const sorted = Array.from(senderCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10); // Top 10

      if (sorted.length === 0) {
        console.log(chalk.yellow('No emails found in INBOX'));
        return;
      }

      console.log(chalk.blue(`\n📊 Top senders by message count:\n`));

      sorted.forEach(([key, count], i) => {
        const [name, address] = key.split('|||');
        console.log(`${i + 1}. ${chalk.bold(name)} - ${chalk.cyan(count + ' messages')}`);
        if (name !== address) {
          console.log(`   ${chalk.gray(address)}`);
        }
        console.log();
      });

      return;
    }

    // Handle "unique senders" query directly
    if (lowerQuery.includes('unique sender') || lowerQuery.includes('who sent') || lowerQuery.includes('senders')) {
      const emails = await this.getLocalEmails({
        folder: 'INBOX',
        limit: 10000
      });

      // Extract unique senders
      const senderMap = new Map();
      emails.forEach(email => {
        const address = email.from_address || 'Unknown';
        const name = email.from_name || '';
        if (!senderMap.has(address)) {
          senderMap.set(address, name);
        }
      });

      if (senderMap.size === 0) {
        console.log(chalk.yellow('No emails found in INBOX'));
        return;
      }

      console.log(chalk.blue(`\n📧 Unique senders in INBOX (${senderMap.size} total):\n`));

      let count = 0;
      senderMap.forEach((name, address) => {
        count++;
        if (count <= 20) { // Show first 20
          // Format based on whether we have a separate name
          if (name && name !== address && !name.includes(address)) {
            console.log(`  ${count}. ${chalk.bold(name)} <${chalk.gray(address)}>`);
          } else {
            console.log(`  ${count}. ${chalk.gray(address)}`);
          }
        }
      });

      if (senderMap.size > 20) {
        console.log(chalk.gray(`\n  ... and ${senderMap.size - 20} more`));
      }
      console.log(); // Add final newline

      return;
    }

    // For search-like queries, try using Claude to filter emails directly
    const searchKeywords = ['show', 'find', 'search', 'list', 'personal', 'important', 'from', 'about'];
    const isSearchQuery = searchKeywords.some(keyword => lowerQuery.includes(keyword));
    
    if (isSearchQuery && this.nlSearch.client) {
      try {
        // Get a reasonable set of emails to filter
        const baseFilter = {};
        
        // Extract rough time frame if mentioned
        if (query.toLowerCase().includes('today')) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          baseFilter.since = today;
        } else if (query.toLowerCase().includes('yesterday')) {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          yesterday.setHours(0, 0, 0, 0);
          baseFilter.since = yesterday;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          baseFilter.before = today;
        } else if (query.toLowerCase().includes('week')) {
          const weekAgo = new Date();
          weekAgo.setDate(weekAgo.getDate() - 7);
          baseFilter.since = weekAgo;
        }
        
        // Get emails with basic time filter - don't limit too strictly
        const emails = await this.getLocalEmails({ ...baseFilter, limit: 200 });
        
        if (emails.length > 0) {
          // Let Claude filter based on natural language
          console.log(chalk.gray('🤖 Using AI to understand your request...'));
          
          // Debug mode - show what we're sending to Claude
          if (process.env.DEBUG_AI) {
            console.log(chalk.gray(`Sending ${emails.length} emails to AI for filtering`));
            console.log(chalk.gray(`Sample: ${emails[0].from_address} - ${emails[0].subject}`));
          }
          
          const filteredEmails = await this.nlSearch.filterWithClaude(emails, query, 'emails');
          
          if (process.env.DEBUG_AI) {
            console.log(chalk.gray(`AI returned ${filteredEmails.length} emails`));
          }
          
          if (filteredEmails.length === 0) {
            console.log(chalk.yellow('No emails found matching your criteria.'));
            return;
          }
          
          // Process the filtered results
          await this.handleSearch({}, filteredEmails);
          return;
        }
      } catch (error) {
        console.log(chalk.yellow('AI filtering failed, falling back to basic search...'));
        // Fall through to original intent-based handling
      }
    }
    
    // Original intent-based handling as fallback with retry logic
    const intentPrompt = `You are an email assistant. Analyze the user's query and determine their intent.
    
Possible intents:
- SEARCH: User wants to find specific emails
- DELETE: User wants to delete/trash emails
- MOVE: User wants to move emails to a folder
- COUNT: User wants to know how many emails match criteria
- LIST_FOLDERS: User wants to see available folders
- LIST_FOLDER_CONTENTS: User wants to see emails in a specific folder
- SUMMARIZE: User wants a summary of recent emails

Return a JSON object with:
{
  "intent": "INTENT_NAME",
  "parameters": {
    // relevant parameters based on intent
  }
}

For SEARCH/DELETE/MOVE/COUNT, parameters might include:
- from: sender email/name
- subject: subject keywords
- days: number of days back
- content: keywords in email body
- folder: specify folder name (for COUNT, MOVE, or LIST_FOLDER_CONTENTS)
- excludeTypes: array of email types to exclude (e.g., ["newsletters", "advertisements", "automated"])

IMPORTANT: 
1. When user asks about emails "in" a specific folder, extract the folder name.
2. When user mentions a sender name or organization, use the "from" parameter for SEARCH.
3. Remove words like "mail", "emails", "messages" from search terms.
4. "Personal mail" means emails that are NOT newsletters, advertisements, or automated messages.

Examples:
- "how many messages in INBOX folder?" -> {"intent": "COUNT", "parameters": {"folder": "INBOX"}}
- "how many messages in the @Sanelater folder?" -> {"intent": "COUNT", "parameters": {"folder": "@Sanelater"}}
- "show emails in Sent folder" -> {"intent": "LIST_FOLDER_CONTENTS", "parameters": {"folder": "Sent"}}
- "show me Lloyd Estates mail" -> {"intent": "SEARCH", "parameters": {"from": "Lloyd Estates"}}
- "emails from GitHub" -> {"intent": "SEARCH", "parameters": {"from": "GitHub"}}
- "Patreon messages" -> {"intent": "SEARCH", "parameters": {"from": "Patreon"}}
- "Show personal mail from today" -> {"intent": "SEARCH", "parameters": {"days": 1, "excludeTypes": ["newsletters", "advertisements", "automated"]}}
- "today's mail" -> {"intent": "SEARCH", "parameters": {"days": 1}}

User query: "${query}"`;

    let intentResponse;
    let intent;

    try {
      intentResponse = await this.nlSearch.askClaude(intentPrompt, query, {
        model: 'claude-3-haiku-20240307',
        maxTokens: 500
      });

      // Extract JSON from response
      const jsonMatch = intentResponse.match(/\{[\s\S]*\}/);
      intent = JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.log(chalk.yellow('Could not determine intent, using basic search fallback'));
      console.log(chalk.gray(`Error: ${error.message}`));

      // Fallback to simple keyword-based intent detection
      const lowerQuery = query.toLowerCase();
      if (lowerQuery.includes('delete') || lowerQuery.includes('remove') || lowerQuery.includes('trash')) {
        intent = { intent: 'DELETE', parameters: { content: query } };
      } else if (lowerQuery.includes('move')) {
        intent = { intent: 'MOVE', parameters: { content: query } };
      } else if (lowerQuery.includes('count') || lowerQuery.includes('how many')) {
        intent = { intent: 'COUNT', parameters: { content: query } };
      } else if (lowerQuery.includes('folder')) {
        intent = { intent: 'LIST_FOLDERS', parameters: {} };
      } else if (lowerQuery.includes('summar')) {
        intent = { intent: 'SUMMARIZE', parameters: {} };
      } else {
        intent = { intent: 'SEARCH', parameters: { content: query } };
      }
    }

    // Handle the intent
    switch (intent.intent) {
      case 'SEARCH':
        await this.handleSearch(intent.parameters);
        break;
      
      case 'DELETE':
        await this.handleDelete(intent.parameters);
        break;
        
      case 'MOVE':
        await this.handleMove(intent.parameters);
        break;
        
      case 'COUNT':
        await this.handleCount(intent.parameters);
        break;
        
      case 'LIST_FOLDERS':
        await this.handleListFolders();
        break;
        
      case 'LIST_FOLDER_CONTENTS':
        await this.handleListFolderContents(intent.parameters);
        break;
        
      case 'SUMMARIZE':
        await this.handleSummarize(intent.parameters);
        break;
        
      default:
        console.log(chalk.yellow('I\'m not sure how to help with that. Try asking about finding, deleting, or moving emails.'));
    }
  }

  async handleSearch(params, preFilteredEmails = null) {
    // Use pre-filtered emails if provided (from Claude), otherwise do local search
    const emails = preFilteredEmails || await this.getLocalEmails({ ...this.buildFilter(params), limit: 10 });

    if (emails.length === 0) {
      console.log(chalk.yellow('No emails found matching your criteria.'));
      return;
    }

    // In conversation mode, just display the emails without interactive selection
    if (this.inConversationMode) {
      console.log(chalk.green(`\n📧 Found ${emails.length} matching emails:\n`));

      emails.forEach((email, i) => {
        const date = new Date(email.date).toLocaleDateString();
        const subject = email.subject || '(no subject)';
        const from = email.from_name || email.from_address;

        console.log(`${i + 1}. ${chalk.bold(subject)}`);
        console.log(`   From: ${from} | Date: ${date}\n`);
      });

      return;
    }

    // For non-conversation mode, show interactive selection
    console.log(chalk.green(`\nFound ${emails.length} emails:`));

    // Create choices for checkbox selection
    const emailChoices = emails.map((email, i) => {
      const date = new Date(email.date).toLocaleDateString();
      const subject = email.subject || '(no subject)';
      const from = email.from_address.replace(/^"(.+)".*$/, '$1'); // Extract name from quoted email
      return {
        name: `${chalk.bold(subject)} - ${from} (${date})`,
        value: email,
        short: subject.substring(0, 50)
      };
    });

    // Add cancel option
    emailChoices.push({
      name: chalk.gray('[ Cancel ]'),
      value: '__cancel__'
    });

    // Multi-select emails
    const { selectedEmails } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selectedEmails',
      message: 'Select emails (use spacebar to select, enter to confirm)',
      choices: emailChoices,
      pageSize: 15,
      validate: (input) => {
        if (input.includes('__cancel__')) {
          return true;
        }
        if (input.length === 0) {
          return 'Please select at least one email or choose Cancel';
        }
        return true;
      }
    }]);

    // Check if cancelled
    if (selectedEmails.includes('__cancel__') || selectedEmails.length === 0) {
      console.log(chalk.gray('Cancelled'));
      return;
    }

    console.log(chalk.blue(`\nSelected ${selectedEmails.length} email${selectedEmails.length > 1 ? 's' : ''}`));

    // Ask what to do with selected emails
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: `What would you like to do with ${selectedEmails.length} selected email${selectedEmails.length > 1 ? 's' : ''}?`,
      choices: [
        { name: 'View details', value: 'view' },
        { name: 'Delete selected emails', value: 'delete' },
        { name: 'Move to folder', value: 'move' },
        { name: 'Cancel', value: 'nothing' }
      ]
    }]);

    if (action === 'view') {
      if (selectedEmails.length === 1) {
        const email = selectedEmails[0];
        console.log(chalk.blue('\n--- Email Details ---'));
        console.log(chalk.bold('From:'), email.from_address);
        console.log(chalk.bold('To:'), email.to_address);
        console.log(chalk.bold('Subject:'), email.subject);
        console.log(chalk.bold('Date:'), new Date(email.date).toString());
        console.log(chalk.bold('\nContent:'));
        console.log(email.text_content?.substring(0, 500) + '...\n');
      } else {
        // For multiple emails, show them one by one with navigation
        for (let i = 0; i < selectedEmails.length; i++) {
          const email = selectedEmails[i];
          console.log(chalk.blue(`\n--- Email ${i + 1} of ${selectedEmails.length} ---`));
          console.log(chalk.bold('From:'), email.from_address);
          console.log(chalk.bold('To:'), email.to_address);
          console.log(chalk.bold('Subject:'), email.subject);
          console.log(chalk.bold('Date:'), new Date(email.date).toString());
          console.log(chalk.bold('\nContent:'));
          console.log(email.text_content?.substring(0, 500) + '...\n');
          
          if (i < selectedEmails.length - 1) {
            const { continueViewing } = await inquirer.prompt([{
              type: 'confirm',
              name: 'continueViewing',
              message: 'View next email?',
              default: true
            }]);
            
            if (!continueViewing) break;
          }
        }
      }
    } else if (action === 'delete') {
      await this.connect(process.env.EMAIL_ACCOUNT);
      // Group emails by folder since we need to move them from their respective folders
      const emailsByFolder = {};
      selectedEmails.forEach(email => {
        const folder = email.folder || 'INBOX';
        if (!emailsByFolder[folder]) {
          emailsByFolder[folder] = [];
        }
        emailsByFolder[folder].push(email);
      });
      
      // Delete emails from each folder
      for (const [folder, emails] of Object.entries(emailsByFolder)) {
        await this.deleteEmailsFromFolder(emails.map(e => e.uid), folder);
      }
      await this.disconnect();
      
      // Small delay to ensure readline doesn't get confused
      await new Promise(resolve => setTimeout(resolve, 100));
    } else if (action === 'move') {
      await this.connect(process.env.EMAIL_ACCOUNT);
      const folders = await this.getFolders();
      const { folder } = await inquirer.prompt([{
        type: 'list',
        name: 'folder',
        message: 'Move to which folder?',
        choices: folders.map(f => ({ name: f.path, value: f.path }))
      }]);
      
      // Group emails by source folder
      const emailsByFolder = {};
      selectedEmails.forEach(email => {
        const sourceFolder = email.folder || 'INBOX';
        if (!emailsByFolder[sourceFolder]) {
          emailsByFolder[sourceFolder] = [];
        }
        emailsByFolder[sourceFolder].push(email);
      });
      
      // Move emails from each folder
      for (const [sourceFolder, emails] of Object.entries(emailsByFolder)) {
        await this.moveEmailsFromFolder(emails.map(e => e.uid), sourceFolder, folder);
      }
      await this.disconnect();
    }
  }

  async handleDelete(params) {
    const filter = this.buildFilter(params);
    const emails = await this.getLocalEmails(filter);
    
    if (emails.length === 0) {
      console.log(chalk.yellow('No emails found to delete.'));
      return;
    }

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Delete ${emails.length} emails?`,
      default: false
    }]);

    if (confirm) {
      await this.connect(process.env.EMAIL_ACCOUNT);
      await this.deleteEmails(emails.map(e => e.uid));
      await this.disconnect();
    }
  }

  async handleMove(params) {
    const filter = this.buildFilter(params);
    const emails = await this.getLocalEmails(filter);
    
    if (emails.length === 0) {
      console.log(chalk.yellow('No emails found to move.'));
      return;
    }

    await this.connect(process.env.EMAIL_ACCOUNT);
    const folders = await this.getFolders();
    
    let targetFolder = params.folder;
    if (!targetFolder) {
      const { folder } = await inquirer.prompt([{
        type: 'list',
        name: 'folder',
        message: 'Move to which folder?',
        choices: folders.map(f => ({ name: f.path, value: f.path }))
      }]);
      targetFolder = folder;
    }

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Move ${emails.length} emails to ${targetFolder}?`,
      default: false
    }]);

    if (confirm) {
      await this.moveEmails(emails.map(e => e.uid), targetFolder);
    }
    
    await this.disconnect();
  }

  async handleCount(params) {
    const filter = this.buildFilter(params);
    const emails = await this.getLocalEmails(filter);
    console.log(chalk.green(`📊 Found ${emails.length} emails matching your criteria.`));
  }

  async handleListFolders() {
    await this.connect(process.env.EMAIL_ACCOUNT);
    const folders = await this.getFolders();
    
    console.log(chalk.blue('\n📁 Email Folders:'));
    folders.forEach(folder => {
      let special = '';
      if (folder.specialUse) {
        if (Array.isArray(folder.specialUse)) {
          special = chalk.gray(` (${folder.specialUse.join(', ')})`);
        } else {
          special = chalk.gray(` (${folder.specialUse})`);
        }
      }
      console.log(`  • ${folder.path}${special}`);
    });
    
    await this.disconnect();
  }

  async handleListFolderContents(params) {
    if (!params.folder) {
      console.log(chalk.yellow('Please specify which folder you want to see.'));
      return;
    }

    console.log(chalk.blue(`\n📂 Checking folder: ${params.folder}`));
    
    // First check if we have emails from that folder in local database
    const localEmails = await this.getLocalEmails({ 
      folder: params.folder,
      limit: 10 
    });

    if (localEmails.length > 0) {
      console.log(chalk.green(`Found ${localEmails.length} cached emails from ${params.folder}:`));
      localEmails.forEach((email, i) => {
        const date = new Date(email.date).toLocaleDateString();
        console.log(`${i + 1}. ${chalk.bold(email.subject || '(no subject)')} - ${email.from_address} (${date})`);
      });
    } else {
      console.log(chalk.yellow(`No cached emails from ${params.folder}.`));
      console.log(chalk.gray('Note: Only emails from INBOX are downloaded by default.'));
      
      // Offer to download from this folder
      const { download } = await inquirer.prompt([{
        type: 'confirm',
        name: 'download',
        message: `Download recent emails from ${params.folder}?`,
        default: true
      }]);

      if (download) {
        console.log(chalk.blue(`Downloading emails from ${params.folder}...`));
        await this.connect(process.env.EMAIL_ACCOUNT);
        
        try {
          // We'll need to enhance the downloader to support folder downloads
          const { EmailDownloader } = await import('./email-downloader.js');
          const downloader = new EmailDownloader();
          await downloader.downloadEmails(process.env.EMAIL_ACCOUNT, 30, params.folder);
          
          // Now show the downloaded emails
          const newEmails = await this.getLocalEmails({ 
            folder: params.folder,
            limit: 10 
          });
          
          if (newEmails.length > 0) {
            console.log(chalk.green(`\nDownloaded ${newEmails.length} emails:`));
            newEmails.forEach((email, i) => {
              const date = new Date(email.date).toLocaleDateString();
              console.log(`${i + 1}. ${chalk.bold(email.subject || '(no subject)')} - ${email.from_address} (${date})`);
            });
          }
        } catch (error) {
          console.error(chalk.red('Error downloading from folder:'), error.message);
        } finally {
          await this.disconnect();
        }
      }
    }
  }

  async handleSummarize(params) {
    const filter = this.buildFilter(params);
    const emails = await this.getLocalEmails({ ...filter, limit: 20 });
    
    if (emails.length === 0) {
      console.log(chalk.yellow('No recent emails to summarize.'));
      return;
    }

    // Create a summary using Claude
    const emailSummaries = emails.map(e => 
      `From: ${e.from_address}, Subject: ${e.subject}, Date: ${new Date(e.date).toLocaleDateString()}`
    ).join('\n');

    const summaryPrompt = `Summarize these recent emails in a helpful way, grouping by sender or topic as appropriate:\n\n${emailSummaries}`;
    
    const summary = await this.nlSearch.askClaude(
      'You are an email assistant. Provide a concise, organized summary of the emails.',
      summaryPrompt,
      { maxTokens: 500 }
    );

    console.log(chalk.blue('\n📧 Email Summary:'));
    console.log(summary);
  }

  buildFilter(params) {
    const filter = {};
    
    if (params.from) {
      filter.from = params.from;
    }
    if (params.subject) {
      filter.subject = params.subject;
    }
    if (params.days) {
      const since = new Date();
      since.setDate(since.getDate() - params.days);
      filter.since = since;
    }
    if (params.content) {
      // For content search, we'll search in both subject and from fields
      filter.content = params.content;
    }
    if (params.folder) {
      filter.folder = params.folder;
    }
    if (params.excludeTypes) {
      filter.excludeTypes = params.excludeTypes;
    }
    
    return filter;
  }

  // Start downloading emails in the background
  async startBackgroundDownload() {
    if (!process.env.EMAIL_ACCOUNT || !process.env.EMAIL_PASSWORD) {
      return; // Skip if no credentials
    }

    // Run download in background without blocking
    console.log(chalk.gray('🔄 Checking for new emails in background...'));
    
    import('./email-downloader.js').then(({ EmailDownloader }) => {
      const downloader = new EmailDownloader();
      // Download last 7 days in background with silent mode
      downloader.downloadEmails(process.env.EMAIL_ACCOUNT, 7, { background: true })
        .then(() => {
          console.log(chalk.gray('✅ Background email sync completed'));
        })
        .catch(error => {
          // Silently handle errors in background mode
        });
    }).catch(error => {
      // Silently handle import errors
    });
  }

}