#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { NotionAPI } from './notion-api.js';
import { CLIInterface } from './cli-interface.js';
import chalk from 'chalk';

dotenv.config();

const program = new Command();

program
  .name('notion-cli')
  .description('CLI for batch editing Notion database items')
  .version('1.0.0');

program
  .command('edit')
  .description('Interactive mode to select and edit database items')
  .action(async () => {
    try {
      const token = process.env.NOTION_TOKEN;
      if (!token) {
        console.error(chalk.red('Error: NOTION_TOKEN environment variable is required'));
        console.log(chalk.yellow('Please create a .env file with your Notion integration token'));
        console.log(chalk.blue('Get your token from: https://www.notion.so/my-integrations'));
        process.exit(1);
      }

      const notionAPI = new NotionAPI(token);
      const cli = new CLIInterface(notionAPI);
      
      await cli.start();
    } catch (error) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

if (process.argv.length === 2) {
  program.outputHelp();
} else {
  program.parse();
}