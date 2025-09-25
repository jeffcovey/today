#!/usr/bin/env node

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';

config();

async function listAllDatabases() {
  const notion = new Client({ auth: process.env.NOTION_TOKEN });
  
  try {
    console.log(chalk.cyan('\n📚 Fetching all Notion databases...\n'));
    
    const response = await notion.search({
      filter: {
        property: 'object',
        value: 'database'
      },
      page_size: 100
    });
    
    console.log(chalk.green(`Found ${response.results.length} databases:\n`));
    
    const databases = [];
    for (const db of response.results) {
      const title = db.title?.[0]?.plain_text || 'Untitled';
      const id = db.id;
      const url = db.url;
      
      // Get property count and types
      const properties = Object.keys(db.properties || {});
      
      databases.push({
        title,
        id,
        url,
        properties: properties.length
      });
      
      console.log(chalk.yellow(`📁 ${title}`));
      console.log(chalk.gray(`   ID: ${id}`));
      console.log(chalk.gray(`   Properties: ${properties.length}`));
      console.log(chalk.gray(`   URL: ${url}`));
      console.log();
    }
    
    // Group by type if we can infer it
    console.log(chalk.cyan('\n📊 Database Categories:\n'));
    
    const vaults = databases.filter(db => db.title.includes('Vault'));
    const projects = databases.filter(db => db.title.includes('Project'));
    const tasks = databases.filter(db => db.title.includes('Task') || db.title.includes('Action'));
    const time = databases.filter(db => db.title.includes('Year') || db.title.includes('Quarter') || db.title.includes('Month') || db.title.includes('Week') || db.title.includes('Day'));
    const other = databases.filter(db => 
      !vaults.includes(db) && 
      !projects.includes(db) && 
      !tasks.includes(db) && 
      !time.includes(db)
    );
    
    if (vaults.length > 0) {
      console.log(chalk.yellow('Vaults (Content Storage):'));
      vaults.forEach(db => console.log(`  - ${db.title}`));
      console.log();
    }
    
    if (projects.length > 0) {
      console.log(chalk.yellow('Projects:'));
      projects.forEach(db => console.log(`  - ${db.title}`));
      console.log();
    }
    
    if (tasks.length > 0) {
      console.log(chalk.yellow('Tasks/Actions:'));
      tasks.forEach(db => console.log(`  - ${db.title}`));
      console.log();
    }
    
    if (time.length > 0) {
      console.log(chalk.yellow('Time-based Planning:'));
      time.forEach(db => console.log(`  - ${db.title}`));
      console.log();
    }
    
    if (other.length > 0) {
      console.log(chalk.yellow('Other Databases:'));
      other.forEach(db => console.log(`  - ${db.title}`));
      console.log();
    }
    
    console.log(chalk.green(`\n✅ Total: ${databases.length} databases\n`));
    
    // Save to file for reference
    const fs = require('fs').promises;
    await fs.writeFile('notion-databases-list.json', JSON.stringify(databases, null, 2));
    console.log(chalk.gray('Database list saved to: notion-databases-list.json'));
    
  } catch (error) {
    console.error(chalk.red(`Error: ${error.message}`));
  }
}

listAllDatabases();
