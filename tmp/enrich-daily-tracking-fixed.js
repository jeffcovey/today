#!/usr/bin/env node

/**
 * Fixed Daily Tracking Database Enrichment - Extracts ALL properties from Notion
 */

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

config();

const DAILY_DIR = 'vault/notion-migration/daily-tracking';
const BATCH_SIZE = 20; // Smaller batches for better monitoring

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

async function fetchDailyFromNotion(notion, dailyId) {
  try {
    const page = await notion.pages.retrieve({ page_id: dailyId });
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

function extractAllProperties(page) {
  const props = page.properties || {};
  const data = {
    properties: {},
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time
  };

  // Extract ALL properties dynamically
  for (const [key, value] of Object.entries(props)) {
    switch (value.type) {
      case 'title':
        data.properties[key] = value.title?.[0]?.plain_text || '';
        break;
      case 'rich_text':
        data.properties[key] = value.rich_text?.[0]?.plain_text || '';
        break;
      case 'number':
        data.properties[key] = value.number;
        break;
      case 'select':
        data.properties[key] = value.select?.name || '';
        break;
      case 'multi_select':
        data.properties[key] = value.multi_select?.map(s => s.name) || [];
        break;
      case 'date':
        data.properties[key] = value.date?.start || '';
        break;
      case 'checkbox':
        data.properties[key] = value.checkbox;
        break;
      case 'url':
        data.properties[key] = value.url || '';
        break;
      case 'email':
        data.properties[key] = value.email || '';
        break;
      case 'formula':
        if (value.formula?.type === 'string') {
          data.properties[key] = value.formula.string || '';
        } else if (value.formula?.type === 'number') {
          data.properties[key] = value.formula.number;
        } else if (value.formula?.type === 'boolean') {
          data.properties[key] = value.formula.boolean;
        }
        break;
      case 'relation':
        data.properties[key] = value.relation?.map(r => r.id) || [];
        break;
      case 'rollup':
        if (value.rollup?.type === 'number') {
          data.properties[key] = value.rollup.number;
        } else if (value.rollup?.type === 'array') {
          data.properties[key] = value.rollup.array?.length || 0;
        }
        break;
      case 'created_time':
        data.properties[key] = value.created_time;
        break;
      case 'last_edited_time':
        data.properties[key] = value.last_edited_time;
        break;
    }
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

      case 'toggle':
        const toggle = block.toggle?.rich_text?.map(t => t.plain_text).join('') || '';
        if (toggle) markdown += `<details><summary>${toggle}</summary>\n\n`;
        break;

      case 'quote':
        const quote = block.quote?.rich_text?.map(t => t.plain_text).join('') || '';
        if (quote) markdown += `> ${quote}\n\n`;
        break;

      case 'code':
        const code = block.code?.rich_text?.map(t => t.plain_text).join('') || '';
        const lang = block.code?.language || '';
        if (code) markdown += `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
        break;

      case 'divider':
        markdown += '---\n\n';
        break;
    }
  }

  return markdown;
}

function createEnrichedContent(notionId, data, blocks) {
  const content = convertBlocksToMarkdown(blocks);
  const props = data.properties;

  // Extract key properties for frontmatter
  const date = props['Date'] || props['Title'] || '';
  const title = props['Title'] || date;

  // Build frontmatter with all important properties
  const frontmatterItems = [
    '---',
    `notion_id: "${notionId}"`,
    `date: "${date}"`,
    `title: "${title}"`,
    `migration_status: enriched`
  ];

  // Add numeric properties
  if (props['% of Day On-Schedule'] !== undefined) {
    frontmatterItems.push(`percent_on_schedule: ${props['% of Day On-Schedule']}`);
  }
  if (props['% of Planned Output Completed'] !== undefined) {
    frontmatterItems.push(`percent_output_completed: ${props['% of Planned Output Completed']}`);
  }
  if (props['🍲 Diet: 1-5'] !== undefined) {
    frontmatterItems.push(`diet_rating: ${props['🍲 Diet: 1-5']}`);
  }

  // Add checkbox properties
  if (props['Finish Day\'s Tasks'] !== undefined) {
    frontmatterItems.push(`finish_days_tasks: ${props['Finish Day\'s Tasks']}`);
  }

  // Add text properties (escaped for YAML)
  if (props['Goals']) {
    frontmatterItems.push(`goals: "${props['Goals'].replace(/"/g, '\\"')}"`);
  }
  if (props['Not-to-Do']) {
    frontmatterItems.push(`not_to_do: "${props['Not-to-Do'].replace(/"/g, '\\"')}"`);
  }
  if (props['I\'m grateful for...']) {
    frontmatterItems.push(`gratitude: "${props['I\'m grateful for...'].replace(/"/g, '\\"')}"`);
  }

  // Add formula properties
  if (props['Day']) {
    frontmatterItems.push(`day_of_week: "${props['Day']}"`);
  }

  // Add relation counts
  if (props['Yesterday']?.length > 0) {
    frontmatterItems.push(`yesterday_id: "${props['Yesterday'][0]}"`);
  }
  if (props['Week']?.length > 0) {
    frontmatterItems.push(`week_id: "${props['Week'][0]}"`);
  }

  // Add metadata
  frontmatterItems.push(`created_time: "${data.created_time}"`);
  frontmatterItems.push(`last_edited_time: "${data.last_edited_time}"`);
  frontmatterItems.push(`notion_url: "${data.url}"`);
  frontmatterItems.push('---');

  const frontmatter = frontmatterItems.join('\n');

  // Build the body with all properties displayed
  const bodyParts = ['', `# Daily Tracking - ${title}`, ''];

  // Add metrics section
  bodyParts.push('## 📊 Daily Metrics');
  bodyParts.push('');
  if (props['% of Day On-Schedule'] !== undefined) {
    const schedulePercent = Math.round(props['% of Day On-Schedule'] * 100);
    bodyParts.push(`**On Schedule:** ${schedulePercent}%`);
  }
  if (props['% of Planned Output Completed'] !== undefined) {
    const outputPercent = Math.round(props['% of Planned Output Completed'] * 100);
    bodyParts.push(`**Output Completed:** ${outputPercent}%`);
  }
  if (props['🍲 Diet: 1-5'] !== undefined) {
    bodyParts.push(`**Diet Rating:** ${props['🍲 Diet: 1-5']}/5`);
  }
  if (props['Finish Day\'s Tasks'] !== undefined) {
    bodyParts.push(`**Finished Day's Tasks:** ${props['Finish Day\'s Tasks'] ? '✅' : '❌'}`);
  }
  bodyParts.push('');

  // Add goals and planning
  if (props['Goals'] || props['Not-to-Do']) {
    bodyParts.push('## 🎯 Goals & Focus');
    bodyParts.push('');
    if (props['Goals']) {
      bodyParts.push(`**Goals:** ${props['Goals']}`);
    }
    if (props['Not-to-Do']) {
      bodyParts.push(`**Not-to-Do:** ${props['Not-to-Do']}`);
    }
    bodyParts.push('');
  }

  // Add gratitude
  if (props['I\'m grateful for...']) {
    bodyParts.push('## 🙏 Gratitude');
    bodyParts.push('');
    bodyParts.push(props['I\'m grateful for...']);
    bodyParts.push('');
  }

  // Add successes
  if (props['🙌 Successes']) {
    bodyParts.push('## 🙌 Successes');
    bodyParts.push('');
    bodyParts.push(props['🙌 Successes']);
    bodyParts.push('');
  }

  // Add check-ins
  if (props['Mid-day Check-in']) {
    bodyParts.push('## 🕐 Mid-day Check-in');
    bodyParts.push('');
    bodyParts.push(props['Mid-day Check-in']);
    bodyParts.push('');
  }

  // Add morning routine notes
  if (props['Morning Routine Notes']) {
    bodyParts.push('## 🌅 Morning Routine Notes');
    bodyParts.push('');
    bodyParts.push(props['Morning Routine Notes']);
    bodyParts.push('');
  }

  // Add lessons
  if (props['Lessons']) {
    bodyParts.push('## 📚 Lessons');
    bodyParts.push('');
    bodyParts.push(props['Lessons']);
    bodyParts.push('');
  }

  // Add any content from blocks
  if (content) {
    bodyParts.push('## 📝 Notes');
    bodyParts.push('');
    bodyParts.push(content);
  }

  // Add metadata footer
  bodyParts.push('---');
  bodyParts.push(`*Enriched from Notion on ${new Date().toISOString().split('T')[0]}*`);
  bodyParts.push('');

  return frontmatter + bodyParts.join('\n');
}

async function main() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n🚀 Fixed Daily Tracking Database Enrichment\n'));

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

        const data = extractAllProperties(result.page);
        const enrichedContent = createEnrichedContent(notionId, data, result.blocks);

        await fs.writeFile(filepath, enrichedContent, 'utf-8');
        console.log(chalk.green(' ✓'));
        enriched++;

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      console.log(chalk.cyan(`  Batch ${batchCount} complete: ${enriched} enriched so far`));
    }

    console.log(chalk.cyan('\n📊 Summary:\n'));
    console.log(chalk.green(`  ✅ Enriched: ${enriched}`));
    console.log(chalk.yellow(`  ⏭️  Skipped: ${skipped}`));
    console.log(chalk.red(`  ❌ Failed: ${failed}`));

  } catch (error) {
    console.error(chalk.red(`\n❌ Fatal error: ${error.message}`));
    console.error(error);
    process.exit(1);
  }
}

main();