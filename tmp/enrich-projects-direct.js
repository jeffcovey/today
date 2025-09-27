#!/usr/bin/env node

/**
 * Direct Project Enrichment - Fetches full content from Notion
 */

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

config();

const PROJECTS_DIR = 'vault/notion-migration/projects';

async function getAllProjectFiles() {
  const files = await fs.readdir(PROJECTS_DIR);
  return files.filter(f => f.endsWith('.md'));
}

async function readProjectFile(filename) {
  const filepath = path.join(PROJECTS_DIR, filename);
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

async function fetchProjectFromNotion(notion, projectId) {
  try {
    // Get the page
    const page = await notion.pages.retrieve({ page_id: projectId });

    // Get the page content (blocks)
    const blocks = await notion.blocks.children.list({
      block_id: projectId,
      page_size: 100
    });

    return { page, blocks: blocks.results };
  } catch (error) {
    console.error(chalk.red(`Error fetching ${projectId}: ${error.message}`));
    return null;
  }
}

function extractProjectData(page) {
  const props = page.properties || {};
  const data = {
    title: '',
    status: '',
    description: '',
    start_date: '',
    end_date: '',
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    tasks: [],
    people: [],
    tags: []
  };

  // Extract title
  if (props['Name']?.title?.[0]) {
    data.title = props['Name'].title[0].plain_text;
  } else if (props['Project Name']?.title?.[0]) {
    data.title = props['Project Name'].title[0].plain_text;
  }

  // Extract status
  if (props['Status']?.status) {
    data.status = props['Status'].status.name;
  } else if (props['Status']?.select) {
    data.status = props['Status'].select.name;
  }

  // Extract dates
  if (props['Timeline']?.date) {
    data.start_date = props['Timeline'].date.start;
    data.end_date = props['Timeline'].date.end;
  } else if (props['Timeline Dates']?.date) {
    data.start_date = props['Timeline Dates'].date.start;
    data.end_date = props['Timeline Dates'].date.end;
  }

  // Extract related items
  if (props['Action Items (Tasks)']?.relation) {
    data.tasks = props['Action Items (Tasks)'].relation.map(r => r.id);
  }
  if (props['People Database']?.relation) {
    data.people = props['People Database'].relation.map(r => r.id);
  }
  if (props['Tag/Knowledge Vault']?.relation) {
    data.tags = props['Tag/Knowledge Vault'].relation.map(r => r.id);
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
        markdown += text + '\n\n';
        break;

      case 'heading_1':
        const h1 = block.heading_1?.rich_text?.map(t => t.plain_text).join('') || '';
        markdown += `# ${h1}\n\n`;
        break;

      case 'heading_2':
        const h2 = block.heading_2?.rich_text?.map(t => t.plain_text).join('') || '';
        markdown += `## ${h2}\n\n`;
        break;

      case 'heading_3':
        const h3 = block.heading_3?.rich_text?.map(t => t.plain_text).join('') || '';
        markdown += `### ${h3}\n\n`;
        break;

      case 'bulleted_list_item':
        const bullet = block.bulleted_list_item?.rich_text?.map(t => t.plain_text).join('') || '';
        markdown += `- ${bullet}\n`;
        break;

      case 'numbered_list_item':
        const number = block.numbered_list_item?.rich_text?.map(t => t.plain_text).join('') || '';
        markdown += `1. ${number}\n`;
        break;

      case 'to_do':
        const todo = block.to_do?.rich_text?.map(t => t.plain_text).join('') || '';
        const checked = block.to_do?.checked ? 'x' : ' ';
        markdown += `- [${checked}] ${todo}\n`;
        break;

      case 'toggle':
        const toggle = block.toggle?.rich_text?.map(t => t.plain_text).join('') || '';
        markdown += `<details><summary>${toggle}</summary>\n\n`;
        // Would need to fetch children here
        markdown += `</details>\n\n`;
        break;

      case 'code':
        const code = block.code?.rich_text?.map(t => t.plain_text).join('') || '';
        const lang = block.code?.language || '';
        markdown += `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
        break;

      case 'quote':
        const quote = block.quote?.rich_text?.map(t => t.plain_text).join('') || '';
        markdown += `> ${quote}\n\n`;
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

  const frontmatter = [
    '---',
    `notion_id: "${notionId}"`,
    `title: "${data.title.replace(/"/g, '\\"')}"`,
    `migration_status: enriched`,
    data.status ? `status: "${data.status}"` : '',
    data.start_date ? `start_date: "${data.start_date}"` : '',
    data.end_date ? `end_date: "${data.end_date}"` : '',
    `created_time: "${data.created_time}"`,
    `last_edited_time: "${data.last_edited_time}"`,
    `notion_url: "${data.url}"`,
    data.tasks.length > 0 ? `related_tasks: ${data.tasks.length}` : '',
    data.people.length > 0 ? `related_people: ${data.people.length}` : '',
    '---'
  ].filter(line => line && !line.includes(': ""')).join('\n');

  const body = [
    '',
    `# ${data.title}`,
    '',
    data.status ? `**Status:** ${data.status}` : '',
    data.start_date ? `**Timeline:** ${data.start_date} to ${data.end_date || 'ongoing'}` : '',
    '',
    '## Content',
    '',
    content || '*No content found in Notion*',
    '',
    data.tasks.length > 0 ? `## Related Tasks (${data.tasks.length})\n\n*Task IDs preserved for cross-referencing*\n` : '',
    data.people.length > 0 ? `## Related People (${data.people.length})\n\n*People IDs preserved for cross-referencing*\n` : '',
    '',
    '---',
    `*Enriched from Notion on ${new Date().toISOString().split('T')[0]}*`,
    ''
  ].filter(line => line !== null).join('\n');

  return frontmatter + body;
}

async function main() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n🚀 Direct Project Enrichment\n'));

  const notion = new Client({ auth: notionToken });

  try {
    const projectFiles = await getAllProjectFiles();
    console.log(chalk.yellow(`Found ${projectFiles.length} project files\n`));

    let enriched = 0;
    let skipped = 0;
    let failed = 0;

    for (const filename of projectFiles) {
      const { filepath, content } = await readProjectFile(filename);

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

      const result = await fetchProjectFromNotion(notion, notionId);
      if (!result) {
        console.log(chalk.red(' ✗'));
        failed++;
        continue;
      }

      const data = extractProjectData(result.page);
      const enrichedContent = createEnrichedContent(notionId, data, result.blocks);

      await fs.writeFile(filepath, enrichedContent, 'utf-8');
      console.log(chalk.green(' ✓'));
      enriched++;

      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
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