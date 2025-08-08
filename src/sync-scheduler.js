#!/usr/bin/env node

import dotenv from 'dotenv';
import chalk from 'chalk';
import { NotionAPI } from './notion-api.js';
import { TodoistSync } from './todoist-sync.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

class SyncScheduler {
  constructor() {
    this.configPath = path.join(process.cwd(), '.sync-config.json');
    this.logPath = path.join(process.cwd(), '.sync-log.json');
    this.config = this.loadConfig();
    this.isRunning = false;
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
      let logs = [];
      if (fs.existsSync(this.logPath)) {
        logs = JSON.parse(fs.readFileSync(this.logPath, 'utf8'));
      }

      logs.push({
        timestamp: new Date().toISOString(),
        ...result
      });

      if (logs.length > 100) {
        logs = logs.slice(-100);
      }

      fs.writeFileSync(this.logPath, JSON.stringify(logs, null, 2));
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