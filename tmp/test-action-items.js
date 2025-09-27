#!/usr/bin/env node

import { config } from 'dotenv';
import { NotionAPI } from '../src/notion-api.js';
import chalk from 'chalk';

config();

const ACTION_ITEMS_DB_ID = 'de1740b0-2421-43a1-8bda-f177cec69e11';

async function testActionItems() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan('\n🧪 Testing Action Items Database Query\n'));

  const notion = new NotionAPI(notionToken);

  try {
    console.log(chalk.yellow('Querying with page_size: 1...'));

    const response = await notion.notion.databases.query({
      database_id: ACTION_ITEMS_DB_ID,
      page_size: 1
    });

    console.log(chalk.green('✅ Query successful!'));
    console.log(chalk.blue(`Results found: ${response.results.length}`));
    console.log(chalk.blue(`Has more: ${response.has_more}`));

    if (response.results.length > 0) {
      const item = response.results[0];
      console.log(chalk.cyan('\nFirst item properties:'));
      console.log('ID:', item.id);
      console.log('Created:', item.created_time);
      console.log('Properties:', Object.keys(item.properties || {}));
    }

  } catch (error) {
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    console.error(error);
  } finally {
    notion.close();
  }
}

testActionItems();