#!/usr/bin/env node

/**
 * Fast Action Items Migration - Creates placeholder files only
 */

import { config } from 'dotenv';
import { NotionAPI } from '../src/notion-api.js';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

config();

const ACTION_ITEMS_DB_ID = 'de1740b0-2421-43a1-8bda-f177cec69e11';
const OUTPUT_DIR = 'vault/notion-migration/tasks';
const PAGE_SIZE = 100;
const MAX_ITEMS = 2000; // Safety limit

async function ensureDirectory(dirPath) {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

function sanitizeFileName(title, index) {
  if (!title || title.trim() === '') {
    return `task-${index}`;
  }
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) + `-${index}`; // Add index to prevent duplicates
}

async function main() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n⚡ Fast Action Items Migration\n'));
  console.log(chalk.yellow(`Max items: ${MAX_ITEMS} (safety limit)`));

  const notion = new NotionAPI(notionToken);

  try {
    await ensureDirectory(OUTPUT_DIR);

    let cursor = undefined;
    let hasMore = true;
    let totalItems = 0;
    let pageNum = 0;

    while (hasMore && totalItems < MAX_ITEMS) {
      pageNum++;
      process.stdout.write(`\r📦 Fetching page ${pageNum}... (${totalItems} items so far)`);

      const queryParams = {
        database_id: ACTION_ITEMS_DB_ID,
        page_size: PAGE_SIZE
      };

      if (cursor) {
        queryParams.start_cursor = cursor;
      }

      const response = await notion.notion.databases.query(queryParams);

      if (!response.results || response.results.length === 0) {
        break;
      }

      // Process this batch
      for (const item of response.results) {
        totalItems++;

        // Extract title from Action Item property
        const title = item.properties?.['Action Item']?.title?.[0]?.plain_text || `Task ${totalItems}`;
        const fileName = sanitizeFileName(title, totalItems);

        // Create minimal placeholder content
        const content = [
          '---',
          `notion_id: "${item.id}"`,
          `title: "${title.replace(/"/g, '\\"')}"`,
          `migration_status: placeholder`,
          `created: "${item.created_time}"`,
          '---',
          '',
          `# ${title}`,
          '',
          '*Placeholder - run enrichment to get full content*',
          ''
        ].join('\n');

        // Write file immediately
        const filePath = path.join(OUTPUT_DIR, `${fileName}.md`);
        await fs.writeFile(filePath, content, 'utf-8');

        if (totalItems >= MAX_ITEMS) {
          console.log(chalk.yellow('\n⚠️ Reached safety limit'));
          break;
        }
      }

      hasMore = response.has_more;
      cursor = response.next_cursor;
    }

    console.log(chalk.green(`\n\n✅ Migrated ${totalItems} Action Items`));
    console.log(chalk.cyan(`📁 Files created in: ${OUTPUT_DIR}`));

  } catch (error) {
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    console.error(error);
    process.exit(1);
  } finally {
    notion.close();
  }
}

main();