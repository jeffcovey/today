#!/usr/bin/env node

/**
 * Complete Action Items Migration - No Limits
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
    .slice(0, 80) + `-${index}`;
}

async function main() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n🚀 Complete Action Items Migration\n'));
  console.log(chalk.yellow('NO LIMITS - Migrating ALL items'));
  console.log(chalk.yellow(`Output: ${OUTPUT_DIR}\n`));

  // First, clear existing files to avoid duplicates
  console.log(chalk.yellow('Clearing existing task files...'));
  try {
    const existingFiles = await fs.readdir(OUTPUT_DIR);
    for (const file of existingFiles) {
      if (file.endsWith('.md')) {
        await fs.unlink(path.join(OUTPUT_DIR, file));
      }
    }
    console.log(chalk.green(`Cleared ${existingFiles.length} existing files`));
  } catch (err) {
    console.log(chalk.gray('No existing files to clear'));
  }

  const notion = new NotionAPI(notionToken);

  try {
    await ensureDirectory(OUTPUT_DIR);

    let cursor = undefined;
    let hasMore = true;
    let totalItems = 0;
    let pageNum = 0;
    const startTime = Date.now();

    while (hasMore) {
      pageNum++;
      const pageStartTime = Date.now();

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
      const batchFiles = [];
      for (const item of response.results) {
        totalItems++;

        // Extract title from Action Item property
        const title = item.properties?.['Action Item']?.title?.[0]?.plain_text || `Task ${totalItems}`;
        const fileName = sanitizeFileName(title, totalItems);

        // Extract key properties for the placeholder
        const status = item.properties?.['Status']?.status?.name || '';
        const priority = item.properties?.['Priority']?.select?.name || '';
        const dueDate = item.properties?.['Do Date']?.date?.start || '';
        const project = item.properties?.['Projects (DB)']?.relation?.[0]?.id || '';

        // Create placeholder content with more metadata
        const content = [
          '---',
          `notion_id: "${item.id}"`,
          `title: "${title.replace(/"/g, '\\"')}"`,
          `migration_status: placeholder`,
          `created: "${item.created_time}"`,
          `modified: "${item.last_edited_time}"`,
          status ? `status: "${status}"` : '',
          priority ? `priority: "${priority}"` : '',
          dueDate ? `due_date: "${dueDate}"` : '',
          project ? `project_id: "${project}"` : '',
          '---',
          '',
          `# ${title}`,
          '',
          status ? `**Status:** ${status}` : '',
          priority ? `**Priority:** ${priority}` : '',
          dueDate ? `**Due:** ${new Date(dueDate).toLocaleDateString()}` : '',
          '',
          '*Placeholder - run enrichment to get full content*',
          ''
        ].filter(line => line !== '').join('\n');

        // Write file immediately to avoid memory issues
        const filePath = path.join(OUTPUT_DIR, `${fileName}.md`);
        await fs.writeFile(filePath, content, 'utf-8');
      }

      const pageTime = Date.now() - pageStartTime;
      if (pageNum % 10 === 0) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(chalk.gray(` (${elapsed}s elapsed, ${Math.round(pageTime)}ms/page)`));
      }

      hasMore = response.has_more;
      cursor = response.next_cursor;
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);

    console.log(chalk.green(`\n\n✅ Successfully migrated ${totalItems} Action Items!`));
    console.log(chalk.cyan(`📁 Files created in: ${OUTPUT_DIR}`));
    console.log(chalk.blue(`⏱️  Total time: ${totalTime} seconds`));
    console.log(chalk.yellow(`📊 Average: ${Math.round(totalItems / totalTime)} items/second`));

  } catch (error) {
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    console.error(error);
    process.exit(1);
  } finally {
    notion.close();
  }
}

main();