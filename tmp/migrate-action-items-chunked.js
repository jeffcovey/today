#!/usr/bin/env node

/**
 * Chunked Migration Script for Action Items Database
 * Handles thousands of entries without timeout
 */

import { config } from 'dotenv';
import { NotionAPI } from '../src/notion-api.js';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config();

const ACTION_ITEMS_DB_ID = 'de1740b0-2421-43a1-8bda-f177cec69e11';
const OUTPUT_DIR = 'vault/notion-migration/tasks';
const CHUNK_SIZE = 100; // Process 100 items at a time
const DELAY_BETWEEN_CHUNKS = 1000; // 1 second delay between chunks

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFileName(title) {
  if (!title || title.trim() === '') {
    return 'untitled';
  }
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

async function ensureDirectory(dirPath) {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

async function fetchActionItemsChunk(notion, startCursor = undefined) {
  try {
    const queryParams = {
      database_id: ACTION_ITEMS_DB_ID,
      page_size: CHUNK_SIZE
    };

    if (startCursor) {
      queryParams.start_cursor = startCursor;
    }

    const response = await notion.notion.databases.query(queryParams);

    return {
      items: response.results || [],
      hasMore: response.has_more,
      nextCursor: response.next_cursor
    };
  } catch (error) {
    console.error(chalk.red(`Error fetching chunk: ${error.message}`));
    return { items: [], hasMore: false, nextCursor: null };
  }
}

function extractProperties(item) {
  const props = {};

  // Extract all properties from the Notion item
  for (const [key, value] of Object.entries(item.properties || {})) {
    const propType = value.type;

    switch (propType) {
      case 'title':
        // The Action Item property is the title field
        if (key === 'Action Item') {
          props.title = value.title?.[0]?.plain_text || 'Untitled';
        } else {
          props[key] = value.title?.[0]?.plain_text || '';
        }
        break;
      case 'rich_text':
        props[key] = value.rich_text?.[0]?.plain_text || '';
        break;
      case 'select':
        props[key] = value.select?.name || '';
        break;
      case 'multi_select':
        props[key] = value.multi_select?.map(s => s.name) || [];
        break;
      case 'date':
        props[key] = value.date?.start || null;
        break;
      case 'checkbox':
        props[key] = value.checkbox || false;
        break;
      case 'number':
        props[key] = value.number || null;
        break;
      case 'relation':
        props[key] = value.relation?.map(r => r.id) || [];
        break;
      case 'people':
        props[key] = value.people?.map(p => p.name || p.id) || [];
        break;
      case 'status':
        props[key] = value.status?.name || '';
        break;
      default:
        // Store raw value for unknown types
        props[key] = value;
    }
  }

  return props;
}

function createTaskFile(item, index) {
  const props = extractProperties(item);
  const title = props.title || `Task ${index}`;
  const fileName = sanitizeFileName(title);

  // Create YAML frontmatter
  const frontmatter = [
    '---',
    `notion_id: "${item.id}"`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `migration_status: placeholder`,
    `created_time: "${item.created_time}"`,
    `last_edited_time: "${item.last_edited_time}"`,
    `url: "${item.url}"`,
  ];

  // Add other properties
  for (const [key, value] of Object.entries(props)) {
    if (key === 'title') continue;

    if (Array.isArray(value)) {
      if (value.length > 0) {
        frontmatter.push(`${key}:`);
        value.forEach(v => frontmatter.push(`  - "${v}"`));
      }
    } else if (value !== null && value !== '') {
      frontmatter.push(`${key}: "${String(value).replace(/"/g, '\\"')}"`);
    }
  }

  frontmatter.push('---');

  // Create file content
  const content = [
    ...frontmatter,
    '',
    `# ${title}`,
    '',
    `> [!info] Placeholder File`,
    `> This is a placeholder for Notion task: ${item.id}`,
    `> Run enrichment script to populate with full content`,
    '',
    '## Task Details',
    '',
    `**Created:** ${new Date(item.created_time).toLocaleDateString()}`,
    `**Last Modified:** ${new Date(item.last_edited_time).toLocaleDateString()}`,
    `**Notion URL:** ${item.url}`,
    '',
    '## Content',
    '',
    '*Placeholder - content will be added during enrichment phase*',
    ''
  ].join('\n');

  return {
    path: path.join(OUTPUT_DIR, `${fileName}.md`),
    content,
    title
  };
}

async function writeFiles(files) {
  let successful = 0;
  let failed = 0;

  for (const file of files) {
    try {
      await fs.writeFile(file.path, file.content, 'utf-8');
      successful++;
    } catch (error) {
      console.error(chalk.red(`  Failed to write ${file.path}: ${error.message}`));
      failed++;
    }
  }

  return { successful, failed };
}

async function main() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found in environment'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n🚀 Action Items Chunked Migration\n'));
  console.log(chalk.yellow(`Database ID: ${ACTION_ITEMS_DB_ID}`));
  console.log(chalk.yellow(`Output Directory: ${OUTPUT_DIR}`));
  console.log(chalk.yellow(`Chunk Size: ${CHUNK_SIZE} items`));
  console.log(chalk.yellow(`Delay Between Chunks: ${DELAY_BETWEEN_CHUNKS}ms\n`));

  const notion = new NotionAPI(notionToken);

  try {
    await ensureDirectory(OUTPUT_DIR);

    let hasMore = true;
    let cursor = undefined;
    let totalItems = 0;
    let chunkNumber = 0;
    let allFiles = [];

    while (hasMore) {
      chunkNumber++;
      console.log(chalk.cyan(`\n📦 Processing chunk #${chunkNumber}...`));

      const { items, hasMore: more, nextCursor } = await fetchActionItemsChunk(notion, cursor);

      if (items.length === 0) {
        console.log(chalk.gray('  No items in this chunk'));
        break;
      }

      console.log(chalk.green(`  Found ${items.length} items`));
      console.log(chalk.gray(`  Processing items...`));

      // Create placeholder files for this chunk
      const chunkFiles = items.map((item, index) =>
        createTaskFile(item, totalItems + index + 1)
      );

      // Write files for this chunk
      const { successful, failed } = await writeFiles(chunkFiles);
      console.log(chalk.green(`  ✅ Written ${successful} files${failed > 0 ? chalk.red(` (${failed} failed)`) : ''}`));

      allFiles.push(...chunkFiles);
      totalItems += items.length;
      hasMore = more;
      cursor = nextCursor;

      // Progress update
      console.log(chalk.blue(`  Total processed so far: ${totalItems} items`));

      if (hasMore) {
        console.log(chalk.gray(`  Waiting ${DELAY_BETWEEN_CHUNKS}ms before next chunk...`));
        await sleep(DELAY_BETWEEN_CHUNKS);
      }
    }

    // Final summary
    console.log(chalk.cyan('\n📊 MIGRATION COMPLETE\n'));
    console.log(chalk.green.bold(`✅ Successfully migrated ${totalItems} Action Items`));
    console.log(chalk.yellow(`📁 Files created in: ${OUTPUT_DIR}`));

    // Check for duplicates
    const fileNames = new Set();
    let duplicates = 0;
    for (const file of allFiles) {
      const name = path.basename(file.path);
      if (fileNames.has(name)) {
        duplicates++;
      }
      fileNames.add(name);
    }

    if (duplicates > 0) {
      console.log(chalk.yellow(`\n⚠️  Note: ${duplicates} items had duplicate names and were overwritten`));
      console.log(chalk.gray('   Consider using unique IDs in filenames if needed'));
    }

    console.log(chalk.cyan('\n🎯 Next Steps:'));
    console.log(chalk.gray('1. Review the generated task files'));
    console.log(chalk.gray('2. Run enrichment script to add full content'));
    console.log(chalk.gray('3. Update cross-references with other databases'));

  } catch (error) {
    console.error(chalk.red(`\n❌ Fatal error: ${error.message}`));
    console.error(error);
    process.exit(1);
  } finally {
    notion.close();
  }
}

// Help text
if (process.argv.includes('--help')) {
  console.log(`
${chalk.cyan('Action Items Chunked Migration')}

Usage: node tmp/migrate-action-items-chunked.js [options]

Options:
  --help           Show this help

This script migrates the Action Items database in chunks to avoid timeouts.
It creates placeholder files that can be enriched later.

Configuration:
- Chunk size: ${CHUNK_SIZE} items per request
- Delay between chunks: ${DELAY_BETWEEN_CHUNKS}ms
- Output directory: ${OUTPUT_DIR}
`);
  process.exit(0);
}

main();