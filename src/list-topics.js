#!/usr/bin/env node

import dotenv from 'dotenv';
import { NotionAPI } from './notion-api.js';
import chalk from 'chalk';

// Load environment variables
dotenv.config();

async function listAllTags() {
  try {
    // Check for Notion token
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      console.error(chalk.red('Error: NOTION_TOKEN environment variable is required'));
      console.log(chalk.yellow('Please create a .env file with your Notion integration token'));
      console.log(chalk.blue('Get your token from: https://www.notion.so/my-integrations'));
      process.exit(1);
    }

    // Initialize NotionAPI
    const notionAPI = new NotionAPI(token);
    
    console.log(chalk.blue('Connecting to Notion...'));
    
    // Get the Tag/Knowledge Vault database
    const tagDatabase = await notionAPI.getTagsDatabase();
    if (!tagDatabase) {
      console.error(chalk.red('Error: Tag/Knowledge Vault database not found'));
      process.exit(1);
    }
    
    console.log(chalk.green(`Found database: ${tagDatabase.title}`));
    console.log(chalk.gray(`Database ID: ${tagDatabase.id}`));
    console.log(chalk.blue('\nFetching all tags...\n'));
    
    // Get all tags using the getAllTags method
    const tags = await notionAPI.getAllTags();
    
    if (tags.length === 0) {
      console.log(chalk.yellow('No tags found in the database.'));
    } else {
      console.log(chalk.green(`Found ${tags.length} tags:\n`));
      
      // Print tags in a simple list format
      tags.forEach((tag, index) => {
        console.log(`${index + 1}. ${tag.title}`);
      });
      
      console.log(chalk.gray(`\nTotal: ${tags.length} tags`));
    }
    
    // Clean up
    notionAPI.close();
    
  } catch (error) {
    console.error(chalk.red('Error:'), error.message);
    process.exit(1);
  }
}

// Run the script
listAllTags();