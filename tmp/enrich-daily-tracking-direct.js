#!/usr/bin/env node

/**
 * Direct Daily Tracking Database Enrichment - Fetches full content from Notion
 * Processes 901 daily tracking files with batching for performance
 */

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

config();

const DAILY_DIR = 'vault/notion-migration/daily-tracking';
const BATCH_SIZE = 50; // Process in batches to show progress

async function getAllDailyFiles() {
  const files = await fs.readdir(DAILY_DIR);
  return files.filter(f => f.endsWith('.md')).sort();
}

async function readDailyFile(filename) {
  const filepath = path.join(DAILY_DIR, filename);
  const content = await fs.readFile(filepath, 'utf-8');
  return { filepath, content };
}

function extractNotionId(content) {
  const match = content.match(/notion_id:\s*"?([a-f0-9-]+)"?/);
  return match ? match[1] : null;
}

function isPlaceholder(content) {
  return content.includes('migration_status: placeholder');
}

async function fetchDailyFromNotion(notion, dailyId) {
  try {
    // Get the page
    const page = await notion.pages.retrieve({ page_id: dailyId });

    // Get the page content (blocks)
    const blocks = await notion.blocks.children.list({
      block_id: dailyId,
      page_size: 100
    });

    return { page, blocks: blocks.results };
  } catch (error) {
    console.error(chalk.red(`Error fetching ${dailyId}: ${error.message}`));
    return null;
  }
}

function extractDailyData(page) {
  const props = page.properties || {};
  const data = {
    date: '',
    mood: '',
    energy: '',
    productivity: '',
    highlights: [],
    lowlights: [],
    gratitude: [],
    tasks_completed: 0,
    notes: '',
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time
  };

  // Extract date (could be in different fields)
  if (props['Date']?.date) {
    data.date = props['Date'].date.start;
  } else if (props['Day']?.date) {
    data.date = props['Day'].date.start;
  } else if (props['Name']?.title?.[0]) {
    // Sometimes date is in the title
    data.date = props['Name'].title[0].plain_text;
  }

  // Extract mood/energy/productivity scores
  if (props['Mood']?.number) {
    data.mood = props['Mood'].number;
  } else if (props['Mood']?.select) {
    data.mood = props['Mood'].select.name;
  }

  if (props['Energy']?.number) {
    data.energy = props['Energy'].number;
  } else if (props['Energy']?.select) {
    data.energy = props['Energy'].select.name;
  }

  if (props['Productivity']?.number) {
    data.productivity = props['Productivity'].number;
  } else if (props['Productivity']?.select) {
    data.productivity = props['Productivity'].select.name;
  }

  // Extract highlights/lowlights
  if (props['Highlights']?.rich_text?.[0]) {
    data.highlights = props['Highlights'].rich_text[0].plain_text.split('\n').filter(h => h);
  }

  if (props['Lowlights']?.rich_text?.[0]) {
    data.lowlights = props['Lowlights'].rich_text[0].plain_text.split('\n').filter(l => l);
  }

  // Extract gratitude
  if (props['Gratitude']?.rich_text?.[0]) {
    data.gratitude = props['Gratitude'].rich_text[0].plain_text.split('\n').filter(g => g);
  }

  // Extract tasks completed
  if (props['Tasks Completed']?.number) {
    data.tasks_completed = props['Tasks Completed'].number;
  }

  return data;
}

function convertBlocksToMarkdown(blocks) {
  let markdown = '';

  for (const block of blocks) {
    const type = block.type;

    switch (type) {
      case 'paragraph':
        const text = block.paragraph?.rich_text?.map(t => t.plain_text).join('') || '';
        if (text) markdown += text + '\n\n';
        break;

      case 'heading_1':
        const h1 = block.heading_1?.rich_text?.map(t => t.plain_text).join('') || '';
        if (h1) markdown += `# ${h1}\n\n`;
        break;

      case 'heading_2':
        const h2 = block.heading_2?.rich_text?.map(t => t.plain_text).join('') || '';
        if (h2) markdown += `## ${h2}\n\n`;
        break;

      case 'heading_3':
        const h3 = block.heading_3?.rich_text?.map(t => t.plain_text).join('') || '';
        if (h3) markdown += `### ${h3}\n\n`;
        break;

      case 'bulleted_list_item':
        const bullet = block.bulleted_list_item?.rich_text?.map(t => t.plain_text).join('') || '';
        if (bullet) markdown += `- ${bullet}\n`;
        break;

      case 'numbered_list_item':
        const numbered = block.numbered_list_item?.rich_text?.map(t => t.plain_text).join('') || '';
        if (numbered) markdown += `1. ${numbered}\n`;
        break;

      case 'to_do':
        const todo = block.to_do?.rich_text?.map(t => t.plain_text).join('') || '';
        const checked = block.to_do?.checked ? 'x' : ' ';
        if (todo) markdown += `- [${checked}] ${todo}\n`;
        break;

      case 'quote':
        const quote = block.quote?.rich_text?.map(t => t.plain_text).join('') || '';
        if (quote) markdown += `> ${quote}\n\n`;
        break;

      case 'divider':
        markdown += '---\n\n';
        break;
    }
  }

  return markdown;
}

function filenameToDate(filename) {
  // Convert filename like "2023-01-15.md" to proper date
  const dateStr = filename.replace('.md', '');
  return dateStr;
}

function createEnrichedContent(notionId, data, blocks, originalDate) {
  const content = convertBlocksToMarkdown(blocks);
  const date = data.date || originalDate;

  const frontmatter = [
    '---',
    `notion_id: "${notionId}"`,
    `date: "${date}"`,
    `migration_status: enriched`,
    data.mood ? `mood: "${data.mood}"` : '',
    data.energy ? `energy: "${data.energy}"` : '',
    data.productivity ? `productivity: "${data.productivity}"` : '',
    data.tasks_completed ? `tasks_completed: ${data.tasks_completed}` : '',
    data.highlights.length > 0 ? `highlights: ${data.highlights.length}` : '',
    data.lowlights.length > 0 ? `lowlights: ${data.lowlights.length}` : '',
    data.gratitude.length > 0 ? `gratitude_items: ${data.gratitude.length}` : '',
    `created_time: "${data.created_time}"`,
    `last_edited_time: "${data.last_edited_time}"`,
    `notion_url: "${data.url}"`,
    '---'
  ].filter(line => line && !line.includes(': ""')).join('\n');

  const body = [
    '',
    `# Daily Tracking - ${date}`,
    ''
  ];

  // Add metrics if available
  if (data.mood || data.energy || data.productivity) {
    body.push('## Metrics');
    if (data.mood) body.push(`**Mood:** ${data.mood}`);
    if (data.energy) body.push(`**Energy:** ${data.energy}`);
    if (data.productivity) body.push(`**Productivity:** ${data.productivity}`);
    body.push('');
  }

  // Add highlights
  if (data.highlights.length > 0) {
    body.push('## Highlights');
    data.highlights.forEach(h => body.push(`- ${h}`));
    body.push('');
  }

  // Add lowlights
  if (data.lowlights.length > 0) {
    body.push('## Lowlights');
    data.lowlights.forEach(l => body.push(`- ${l}`));
    body.push('');
  }

  // Add gratitude
  if (data.gratitude.length > 0) {
    body.push('## Gratitude');
    data.gratitude.forEach(g => body.push(`- ${g}`));
    body.push('');
  }

  // Add main content
  if (content) {
    body.push('## Notes');
    body.push('');
    body.push(content);
  }

  body.push('---');
  body.push(`*Enriched from Notion on ${new Date().toISOString().split('T')[0]}*`);
  body.push('');

  return frontmatter + body.join('\n');
}

async function main() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n🚀 Direct Daily Tracking Database Enrichment\n'));

  const notion = new Client({ auth: notionToken });

  try {
    const dailyFiles = await getAllDailyFiles();
    console.log(chalk.yellow(`Found ${dailyFiles.length} daily tracking files\n`));

    let enriched = 0;
    let skipped = 0;
    let failed = 0;
    let batchCount = 0;

    for (let i = 0; i < dailyFiles.length; i += BATCH_SIZE) {
      const batch = dailyFiles.slice(i, i + BATCH_SIZE);
      batchCount++;

      console.log(chalk.blue(`\nProcessing batch ${batchCount} (${i + 1}-${Math.min(i + BATCH_SIZE, dailyFiles.length)} of ${dailyFiles.length})`));

      for (const filename of batch) {
        const { filepath, content } = await readDailyFile(filename);

        if (!isPlaceholder(content)) {
          skipped++;
          continue;
        }

        const notionId = extractNotionId(content);
        if (!notionId) {
          console.log(chalk.gray(`  No Notion ID in ${filename}`));
          failed++;
          continue;
        }

        process.stdout.write(`  Enriching ${filename}...`);

        const result = await fetchDailyFromNotion(notion, notionId);
        if (!result) {
          console.log(chalk.red(' ✗'));
          failed++;
          continue;
        }

        const data = extractDailyData(result.page);
        const originalDate = filenameToDate(filename);
        const enrichedContent = createEnrichedContent(notionId, data, result.blocks, originalDate);

        await fs.writeFile(filepath, enrichedContent, 'utf-8');
        console.log(chalk.green(' ✓'));
        enriched++;

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Progress update
      console.log(chalk.cyan(`  Batch ${batchCount} complete: ${enriched} enriched so far`));
    }

    console.log(chalk.cyan('\n📊 Summary:\n'));
    console.log(chalk.green(`  ✅ Enriched: ${enriched}`));
    console.log(chalk.yellow(`  ⏭️  Skipped (already enriched): ${skipped}`));
    console.log(chalk.red(`  ❌ Failed: ${failed}`));

  } catch (error) {
    console.error(chalk.red(`\n❌ Fatal error: ${error.message}`));
    console.error(error);
    process.exit(1);
  }
}

main();