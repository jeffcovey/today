#!/usr/bin/env node

import { config } from 'dotenv';
import { NotionAPI } from '../src/notion-api.js';
import chalk from 'chalk';

config();

const ACTION_ITEMS_DB_ID = 'de1740b0-2421-43a1-8bda-f177cec69e11';

async function countActionItems() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan('\n📊 Counting Action Items\n'));

  const notion = new NotionAPI(notionToken);
  let total = 0;
  let cursor = undefined;
  let hasMore = true;
  let iterations = 0;

  try {
    while (hasMore && iterations < 100) { // Safety limit
      iterations++;
      process.stdout.write(`\rCounting... ${total} items (iteration ${iterations})`);

      const queryParams = {
        database_id: ACTION_ITEMS_DB_ID,
        page_size: 100
      };

      if (cursor) {
        queryParams.start_cursor = cursor;
      }

      const response = await notion.notion.databases.query(queryParams);

      total += response.results.length;
      hasMore = response.has_more;
      cursor = response.next_cursor;
    }

    console.log(chalk.green(`\n\n✅ Total Action Items: ${total}`));

  } catch (error) {
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
  } finally {
    notion.close();
  }
}

countActionItems();