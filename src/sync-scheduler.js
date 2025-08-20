#!/usr/bin/env node

import dotenv from 'dotenv';
import chalk from 'chalk';
import { NotionAPI } from './notion-api.js';
import { TodoistSync } from './todoist-sync.js';
import fs from 'fs';
import path from 'path';
import { getDatabase } from './database-service.js';

dotenv.config();

class SyncScheduler {
  constructor() {
    this.configPath = path.join(process.cwd(), '.sync-config.json');
    this.dbPath = path.join(process.cwd(), '.data', 'today.db');
    // Use unified database service with automatic Turso sync
    this.db = getDatabase(this.dbPath);
    // Pull from Turso at startup
    this.initializeTurso();
    this.initDatabase();
    this.config = this.loadConfig();
    this.isRunning = false;
  }
  
  async initializeTurso() {
    try {
      // Pull latest data from Turso at startup
      await this.db.forcePull();
      console.log(chalk.green('✅ Pulled latest data from Turso'));
    } catch (error) {
      // Turso might not be configured, that's OK
      if (process.env.TURSO_DATABASE_URL) {
        console.log(chalk.yellow('⚠️  Could not pull from Turso:', error.message));
      }
    }
  }
  
  initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        sync_type TEXT,
        success BOOLEAN DEFAULT 0,
        source_system TEXT,
        target_system TEXT,
        created_count INTEGER DEFAULT 0,
        updated_count INTEGER DEFAULT 0,
        deleted_count INTEGER DEFAULT 0,
        skipped_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
    `);
  }

  loadConfig() {
    const defaultConfig = {
      intervalMinutes: 15,
      projectName: 'Notion Tasks',
      enabled: true,
      lastSync: null,
      syncDirection: 'two-way'
    };

    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        return { ...defaultConfig, ...config };
      }
    } catch (error) {
      console.error(chalk.yellow('Failed to load config, using defaults'));
    }

    return defaultConfig;
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error(chalk.red('Failed to save config:'), error.message);
    }
  }

  logSyncResult(result) {
    try {
      const insertSync = this.db.prepare(`
        INSERT INTO sync_log (
          timestamp, success, source_system, target_system,
          created_count, updated_count, deleted_count, skipped_count, error_count,
          details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      // Handle Notion-Todoist sync format
      if (result.result) {
        const n2t = result.result.notionToTodoist || {};
        const t2n = result.result.todoistToNotion || {};
        
        // Log Notion to Todoist
        if (n2t.created !== undefined) {
          insertSync.run(
            new Date().toISOString(),
            result.success ? 1 : 0,
            'notion',
            'todoist',
            n2t.created || 0,
            n2t.updated || 0,
            n2t.deleted || 0,
            n2t.skipped || 0,
            n2t.errors || 0,
            JSON.stringify(n2t)
          );
        }
        
        // Log Todoist to Notion
        if (t2n.created !== undefined) {
          insertSync.run(
            new Date().toISOString(),
            result.success ? 1 : 0,
            'todoist',
            'notion',
            t2n.created || 0,
            t2n.updated || 0,
            0,
            t2n.skipped || 0,
            t2n.errors || 0,
            JSON.stringify(t2n)
          );
        }
      }
    } catch (error) {
      console.error(chalk.red('Failed to log sync result:'), error.message);
    }
  }

  async performSync() {
    if (this.isRunning) {
      console.log(chalk.yellow('Sync already in progress, skipping...'));
      return;
    }

    this.isRunning = true;
    console.log(chalk.blue(`\n[${new Date().toLocaleString()}] Starting scheduled sync...`));

    try {
      const notionToken = process.env.NOTION_TOKEN;
      const todoistToken = process.env.TODOIST_TOKEN;

      if (!notionToken || !todoistToken) {
        throw new Error('Missing required tokens');
      }

      const notionAPI = new NotionAPI(notionToken);
      const databases = await notionAPI.getDatabases();
      
      const actionItemsDB = databases.find(db => 
        db.title.toLowerCase().includes('action items')
      );

      if (!actionItemsDB) {
        throw new Error('Action Items database not found');
      }

      const sync = new TodoistSync(todoistToken, notionAPI);
      let result;

      switch (this.config.syncDirection) {
        case 'notion-to-todoist':
          result = await sync.syncNotionToTodoist(actionItemsDB.id, this.config.projectName);
          break;
        case 'todoist-to-notion':
          result = await sync.syncTodoistToNotion(actionItemsDB.id, this.config.projectName);
          break;
        default:
          result = await sync.performTwoWaySync(actionItemsDB.id, this.config.projectName);
      }

      this.config.lastSync = new Date().toISOString();
      this.saveConfig();
      this.logSyncResult({ success: true, result });

      console.log(chalk.green('✅ Scheduled sync completed successfully'));
    } catch (error) {
      console.error(chalk.red('Sync failed:'), error.message);
      this.logSyncResult({ success: false, error: error.message });
    } finally {
      this.isRunning = false;
    }
  }

  async start() {
    console.log(chalk.blue.bold('🔄 Notion-Todoist Sync Scheduler'));
    console.log(chalk.cyan(`Sync interval: ${this.config.intervalMinutes} minutes`));
    console.log(chalk.cyan(`Project: ${this.config.projectName}`));
    console.log(chalk.cyan(`Direction: ${this.config.syncDirection}`));
    
    if (!this.config.enabled) {
      console.log(chalk.yellow('Sync is disabled in config'));
      return;
    }

    await this.performSync();

    setInterval(async () => {
      await this.performSync();
    }, this.config.intervalMinutes * 60 * 1000);

    console.log(chalk.green('\n✨ Scheduler started. Press Ctrl+C to stop.'));
  }

  async runOnce() {
    console.log(chalk.blue.bold('🔄 Running one-time sync...'));
    await this.performSync();
  }
}

const scheduler = new SyncScheduler();

if (process.argv.includes('--once')) {
  scheduler.runOnce().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
} else if (process.argv.includes('--config')) {
  console.log(chalk.blue('Current configuration:'));
  console.log(JSON.stringify(scheduler.config, null, 2));
} else {
  scheduler.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n👋 Stopping scheduler...'));
    process.exit(0);
  });
}