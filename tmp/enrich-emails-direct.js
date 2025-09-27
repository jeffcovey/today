#!/usr/bin/env node

/**
 * Direct Emails Database Enrichment - Fetches full content from Notion
 * Processes 290 email files
 */

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

config();

const EMAILS_DIR = 'vault/notion-migration/emails';
const BATCH_SIZE = 30; // Process in smaller batches

async function getAllEmailFiles() {
  const files = await fs.readdir(EMAILS_DIR);
  return files.filter(f => f.endsWith('.md')).sort();
}

async function readEmailFile(filename) {
  const filepath = path.join(EMAILS_DIR, filename);
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

async function fetchEmailFromNotion(notion, emailId) {
  try {
    // Get the page
    const page = await notion.pages.retrieve({ page_id: emailId });

    // Get the page content (blocks)
    const blocks = await notion.blocks.children.list({
      block_id: emailId,
      page_size: 100
    });

    return { page, blocks: blocks.results };
  } catch (error) {
    console.error(chalk.red(`Error fetching ${emailId}: ${error.message}`));
    return null;
  }
}

function extractEmailData(page) {
  const props = page.properties || {};
  const data = {
    subject: '',
    from: '',
    to: '',
    date: '',
    status: '',
    category: '',
    priority: '',
    labels: [],
    attachments: '',
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    related_person: null,
    related_project: null
  };

  // Extract subject/title
  if (props['Subject']?.title?.[0]) {
    data.subject = props['Subject'].title[0].plain_text;
  } else if (props['Name']?.title?.[0]) {
    data.subject = props['Name'].title[0].plain_text;
  } else if (props['Email']?.title?.[0]) {
    data.subject = props['Email'].title[0].plain_text;
  }

  // Extract from/to
  if (props['From']?.rich_text?.[0]) {
    data.from = props['From'].rich_text[0].plain_text;
  } else if (props['Sender']?.rich_text?.[0]) {
    data.from = props['Sender'].rich_text[0].plain_text;
  }

  if (props['To']?.rich_text?.[0]) {
    data.to = props['To'].rich_text[0].plain_text;
  } else if (props['Recipient']?.rich_text?.[0]) {
    data.to = props['Recipient'].rich_text[0].plain_text;
  }

  // Extract date
  if (props['Date']?.date) {
    data.date = props['Date'].date.start;
  } else if (props['Sent']?.date) {
    data.date = props['Sent'].date.start;
  } else if (props['Received']?.date) {
    data.date = props['Received'].date.start;
  }

  // Extract status
  if (props['Status']?.select) {
    data.status = props['Status'].select.name;
  } else if (props['State']?.select) {
    data.status = props['State'].select.name;
  }

  // Extract category
  if (props['Category']?.select) {
    data.category = props['Category'].select.name;
  } else if (props['Type']?.select) {
    data.category = props['Type'].select.name;
  }

  // Extract priority
  if (props['Priority']?.select) {
    data.priority = props['Priority'].select.name;
  }

  // Extract labels/tags
  if (props['Labels']?.multi_select) {
    data.labels = props['Labels'].multi_select.map(label => label.name);
  } else if (props['Tags']?.multi_select) {
    data.labels = props['Tags'].multi_select.map(tag => tag.name);
  }

  // Extract attachments
  if (props['Attachments']?.rich_text?.[0]) {
    data.attachments = props['Attachments'].rich_text[0].plain_text;
  }

  // Extract related items
  if (props['Person']?.relation?.[0]) {
    data.related_person = props['Person'].relation[0].id;
  }
  if (props['Project']?.relation?.[0]) {
    data.related_project = props['Project'].relation[0].id;
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

function filenameToSubject(filename) {
  // Remove .md and convert kebab-case to proper subject
  const name = filename.replace('.md', '');
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function createEnrichedContent(notionId, data, blocks, originalSubject) {
  const content = convertBlocksToMarkdown(blocks);
  const subject = data.subject || originalSubject;

  const frontmatter = [
    '---',
    `notion_id: "${notionId}"`,
    `subject: "${subject.replace(/"/g, '\\"')}"`,
    `migration_status: enriched`,
    data.from ? `from: "${data.from}"` : '',
    data.to ? `to: "${data.to}"` : '',
    data.date ? `date: "${data.date}"` : '',
    data.status ? `status: "${data.status}"` : '',
    data.category ? `category: "${data.category}"` : '',
    data.priority ? `priority: "${data.priority}"` : '',
    data.labels.length > 0 ? `labels: [${data.labels.map(l => `"${l}"`).join(', ')}]` : '',
    data.attachments ? `attachments: "${data.attachments}"` : '',
    data.related_person ? `related_person: "${data.related_person}"` : '',
    data.related_project ? `related_project: "${data.related_project}"` : '',
    `created_time: "${data.created_time}"`,
    `last_edited_time: "${data.last_edited_time}"`,
    `notion_url: "${data.url}"`,
    '---'
  ].filter(line => line && !line.includes(': ""')).join('\n');

  const body = [
    '',
    `# ${subject}`,
    '',
    '## Email Details',
    '',
    data.from ? `**From:** ${data.from}` : '',
    data.to ? `**To:** ${data.to}` : '',
    data.date ? `**Date:** ${new Date(data.date).toLocaleString()}` : '',
    data.status ? `**Status:** ${data.status}` : '',
    data.category ? `**Category:** ${data.category}` : '',
    data.priority ? `**Priority:** ${data.priority}` : '',
    data.labels.length > 0 ? `**Labels:** ${data.labels.join(', ')}` : '',
    data.attachments ? `**Attachments:** ${data.attachments}` : '',
    '',
    '## Content',
    '',
    content || '*No content*',
    '',
    data.related_person || data.related_project ? '## Related Items\n' : '',
    data.related_person ? `- Person: ${data.related_person}` : '',
    data.related_project ? `- Project: ${data.related_project}` : '',
    '',
    '---',
    `*Enriched from Notion on ${new Date().toISOString().split('T')[0]}*`,
    ''
  ].filter(line => line !== null && line !== '').join('\n');

  return frontmatter + body;
}

async function main() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n🚀 Direct Emails Database Enrichment\n'));

  const notion = new Client({ auth: notionToken });

  try {
    const emailFiles = await getAllEmailFiles();
    console.log(chalk.yellow(`Found ${emailFiles.length} email files\n`));

    let enriched = 0;
    let skipped = 0;
    let failed = 0;
    let batchCount = 0;

    for (let i = 0; i < emailFiles.length; i += BATCH_SIZE) {
      const batch = emailFiles.slice(i, i + BATCH_SIZE);
      batchCount++;

      console.log(chalk.blue(`\nBatch ${batchCount} (${i + 1}-${Math.min(i + BATCH_SIZE, emailFiles.length)} of ${emailFiles.length})`));

      for (const filename of batch) {
        const { filepath, content } = await readEmailFile(filename);

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

        const result = await fetchEmailFromNotion(notion, notionId);
        if (!result) {
          console.log(chalk.red(' ✗'));
          failed++;
          continue;
        }

        const data = extractEmailData(result.page);
        const originalSubject = filenameToSubject(filename);
        const enrichedContent = createEnrichedContent(notionId, data, result.blocks, originalSubject);

        await fs.writeFile(filepath, enrichedContent, 'utf-8');
        console.log(chalk.green(' ✓'));
        enriched++;

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }
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