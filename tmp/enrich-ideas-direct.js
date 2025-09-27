#!/usr/bin/env node

/**
 * Direct Ideas Database Enrichment - Fetches full content from Notion
 */

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

config();

const IDEAS_DIR = 'vault/notion-migration/ideas';

async function getAllIdeasFiles() {
  const files = await fs.readdir(IDEAS_DIR);
  return files.filter(f => f.endsWith('.md'));
}

async function readIdeaFile(filename) {
  const filepath = path.join(IDEAS_DIR, filename);
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

async function fetchIdeaFromNotion(notion, ideaId) {
  try {
    // Get the page
    const page = await notion.pages.retrieve({ page_id: ideaId });

    // Get the page content (blocks)
    const blocks = await notion.blocks.children.list({
      block_id: ideaId,
      page_size: 100
    });

    return { page, blocks: blocks.results };
  } catch (error) {
    console.error(chalk.red(`Error fetching ${ideaId}: ${error.message}`));
    return null;
  }
}

function extractIdeaData(page) {
  const props = page.properties || {};
  const data = {
    title: '',
    status: '',
    category: '',
    tags: [],
    priority: '',
    created_date: '',
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    related_projects: [],
    related_tasks: []
  };

  // Extract title (could be in different fields)
  if (props['Name']?.title?.[0]) {
    data.title = props['Name'].title[0].plain_text;
  } else if (props['Title']?.title?.[0]) {
    data.title = props['Title'].title[0].plain_text;
  } else if (props['Idea']?.title?.[0]) {
    data.title = props['Idea'].title[0].plain_text;
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

  // Extract tags
  if (props['Tags']?.multi_select) {
    data.tags = props['Tags'].multi_select.map(tag => tag.name);
  }

  // Extract priority
  if (props['Priority']?.select) {
    data.priority = props['Priority'].select.name;
  }

  // Extract dates
  if (props['Date']?.date) {
    data.created_date = props['Date'].date.start;
  } else if (props['Created']?.date) {
    data.created_date = props['Created'].date.start;
  }

  // Extract related items
  if (props['Projects']?.relation) {
    data.related_projects = props['Projects'].relation.map(r => r.id);
  }
  if (props['Tasks']?.relation) {
    data.related_tasks = props['Tasks'].relation.map(r => r.id);
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

      case 'code':
        const code = block.code?.rich_text?.map(t => t.plain_text).join('') || '';
        const lang = block.code?.language || '';
        if (code) markdown += `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
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

function filenameToTitle(filename) {
  // Remove .md and convert kebab-case to proper title
  const name = filename.replace('.md', '');
  return name
    .split('-')
    .map(word => {
      // Handle special cases
      if (word === 'api') return 'API';
      if (word === 'ui') return 'UI';
      if (word === 'ux') return 'UX';
      if (word === 'ai') return 'AI';
      if (word === 'ml') return 'ML';

      // Regular title case
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function createEnrichedContent(notionId, data, blocks, originalTitle) {
  const content = convertBlocksToMarkdown(blocks);
  const title = data.title || originalTitle;

  const frontmatter = [
    '---',
    `notion_id: "${notionId}"`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `migration_status: enriched`,
    data.status ? `status: "${data.status}"` : '',
    data.category ? `category: "${data.category}"` : '',
    data.tags.length > 0 ? `tags: [${data.tags.map(t => `"${t}"`).join(', ')}]` : '',
    data.priority ? `priority: "${data.priority}"` : '',
    data.created_date ? `created_date: "${data.created_date}"` : '',
    `created_time: "${data.created_time}"`,
    `last_edited_time: "${data.last_edited_time}"`,
    `notion_url: "${data.url}"`,
    data.related_projects.length > 0 ? `related_projects: ${data.related_projects.length}` : '',
    data.related_tasks.length > 0 ? `related_tasks: ${data.related_tasks.length}` : '',
    '---'
  ].filter(line => line && !line.includes(': ""')).join('\n');

  const body = [
    '',
    `# ${title}`,
    '',
    data.status ? `**Status:** ${data.status}` : '',
    data.category ? `**Category:** ${data.category}` : '',
    data.priority ? `**Priority:** ${data.priority}` : '',
    data.tags.length > 0 ? `**Tags:** ${data.tags.join(', ')}` : '',
    '',
    '## Content',
    '',
    content || '*No content*',
    '',
    data.related_projects.length > 0 ? `## Related Projects (${data.related_projects.length})\n\n*Project IDs preserved for cross-referencing*\n` : '',
    data.related_tasks.length > 0 ? `## Related Tasks (${data.related_tasks.length})\n\n*Task IDs preserved for cross-referencing*\n` : '',
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

  console.log(chalk.cyan.bold('\n🚀 Direct Ideas Database Enrichment\n'));

  const notion = new Client({ auth: notionToken });

  try {
    const ideaFiles = await getAllIdeasFiles();
    console.log(chalk.yellow(`Found ${ideaFiles.length} idea files\n`));

    let enriched = 0;
    let skipped = 0;
    let failed = 0;

    for (const filename of ideaFiles) {
      const { filepath, content } = await readIdeaFile(filename);

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

      const result = await fetchIdeaFromNotion(notion, notionId);
      if (!result) {
        console.log(chalk.red(' ✗'));
        failed++;
        continue;
      }

      const data = extractIdeaData(result.page);
      const originalTitle = filenameToTitle(filename);
      const enrichedContent = createEnrichedContent(notionId, data, result.blocks, originalTitle);

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