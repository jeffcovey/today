#!/usr/bin/env node

/**
 * Debug script to inspect actual Notion properties for a specific page
 */

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';

config();

// The specific daily tracking page from the screenshot
const PAGE_ID = '911ff862-bf59-44d1-b0ed-d93b0d10b64b'; // 2023-02-11

async function debugPage() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n🔍 Debug Notion Page Properties\n'));

  const notion = new Client({ auth: notionToken });

  try {
    // Get the page
    const page = await notion.pages.retrieve({ page_id: PAGE_ID });

    console.log(chalk.yellow('Page Title:'), page.properties?.title || page.properties?.Name || 'Unknown');
    console.log(chalk.yellow('Page URL:'), page.url);
    console.log(chalk.yellow('\nAll Properties:\n'));

    // List all properties with their types and values
    for (const [key, value] of Object.entries(page.properties || {})) {
      console.log(chalk.green(`\n"${key}":`));
      console.log('  Type:', chalk.blue(value.type));

      // Show the value based on type
      switch (value.type) {
        case 'title':
          console.log('  Value:', value.title?.[0]?.plain_text || '(empty)');
          break;
        case 'rich_text':
          console.log('  Value:', value.rich_text?.[0]?.plain_text || '(empty)');
          break;
        case 'number':
          console.log('  Value:', value.number ?? '(empty)');
          break;
        case 'select':
          console.log('  Value:', value.select?.name || '(empty)');
          break;
        case 'multi_select':
          console.log('  Value:', value.multi_select?.map(s => s.name).join(', ') || '(empty)');
          break;
        case 'date':
          console.log('  Value:', value.date?.start || '(empty)');
          break;
        case 'checkbox':
          console.log('  Value:', value.checkbox);
          break;
        case 'url':
          console.log('  Value:', value.url || '(empty)');
          break;
        case 'email':
          console.log('  Value:', value.email || '(empty)');
          break;
        case 'phone_number':
          console.log('  Value:', value.phone_number || '(empty)');
          break;
        case 'formula':
          console.log('  Formula Type:', value.formula?.type);
          if (value.formula?.type === 'string') {
            console.log('  Value:', value.formula.string || '(empty)');
          } else if (value.formula?.type === 'number') {
            console.log('  Value:', value.formula.number ?? '(empty)');
          } else if (value.formula?.type === 'boolean') {
            console.log('  Value:', value.formula.boolean);
          } else if (value.formula?.type === 'date') {
            console.log('  Value:', value.formula.date?.start || '(empty)');
          }
          break;
        case 'relation':
          console.log('  Relations:', value.relation?.length || 0);
          if (value.relation?.length > 0) {
            value.relation.forEach((rel, i) => {
              console.log(`    [${i}]:`, rel.id);
            });
          }
          break;
        case 'rollup':
          console.log('  Rollup Type:', value.rollup?.type);
          if (value.rollup?.type === 'number') {
            console.log('  Value:', value.rollup.number ?? '(empty)');
          } else if (value.rollup?.type === 'array') {
            console.log('  Array Length:', value.rollup.array?.length || 0);
          }
          break;
        case 'created_time':
          console.log('  Value:', value.created_time);
          break;
        case 'last_edited_time':
          console.log('  Value:', value.last_edited_time);
          break;
        default:
          console.log('  Raw Value:', JSON.stringify(value, null, 2));
      }
    }

    // Also get the blocks (content)
    console.log(chalk.yellow('\n\nPage Content Blocks:\n'));
    const blocks = await notion.blocks.children.list({
      block_id: PAGE_ID,
      page_size: 100
    });

    blocks.results.forEach((block, index) => {
      console.log(chalk.blue(`Block ${index + 1}:`), block.type);
      if (block.type === 'paragraph' && block.paragraph?.rich_text?.length > 0) {
        console.log('  Text:', block.paragraph.rich_text[0].plain_text);
      }
    });

  } catch (error) {
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    console.error(error);
    process.exit(1);
  }
}

debugPage();