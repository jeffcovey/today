#!/usr/bin/env node

/**
 * Direct People Database Enrichment - Fetches full content from Notion
 */

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

config();

const PEOPLE_DIR = 'vault/notion-migration/people';

async function getAllPeopleFiles() {
  const files = await fs.readdir(PEOPLE_DIR);
  return files.filter(f => f.endsWith('.md'));
}

async function readPersonFile(filename) {
  const filepath = path.join(PEOPLE_DIR, filename);
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

async function fetchPersonFromNotion(notion, personId) {
  try {
    // Get the page
    const page = await notion.pages.retrieve({ page_id: personId });

    // Get the page content (blocks)
    const blocks = await notion.blocks.children.list({
      block_id: personId,
      page_size: 100
    });

    return { page, blocks: blocks.results };
  } catch (error) {
    console.error(chalk.red(`Error fetching ${personId}: ${error.message}`));
    return null;
  }
}

function extractPersonData(page) {
  const props = page.properties || {};
  const data = {
    name: '',
    email: '',
    phone: '',
    location: '',
    company: '',
    notes: '',
    last_contact: '',
    relationship: '',
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    projects: [],
    tasks: []
  };

  // Extract name (could be in different fields)
  if (props['Name']?.title?.[0]) {
    data.name = props['Name'].title[0].plain_text;
  } else if (props['Full Name']?.title?.[0]) {
    data.name = props['Full Name'].title[0].plain_text;
  } else if (props['Person']?.title?.[0]) {
    data.name = props['Person'].title[0].plain_text;
  }

  // Extract contact info
  if (props['Email']?.email) {
    data.email = props['Email'].email;
  } else if (props['Email']?.rich_text?.[0]) {
    data.email = props['Email'].rich_text[0].plain_text;
  }

  if (props['Phone']?.phone_number) {
    data.phone = props['Phone'].phone_number;
  } else if (props['Phone']?.rich_text?.[0]) {
    data.phone = props['Phone'].rich_text[0].plain_text;
  }

  // Extract location
  if (props['Location']?.rich_text?.[0]) {
    data.location = props['Location'].rich_text[0].plain_text;
  } else if (props['City']?.rich_text?.[0]) {
    data.location = props['City'].rich_text[0].plain_text;
  }

  // Extract company
  if (props['Company']?.rich_text?.[0]) {
    data.company = props['Company'].rich_text[0].plain_text;
  } else if (props['Organization']?.rich_text?.[0]) {
    data.company = props['Organization'].rich_text[0].plain_text;
  }

  // Extract relationship
  if (props['Relationship']?.select) {
    data.relationship = props['Relationship'].select.name;
  } else if (props['Type']?.select) {
    data.relationship = props['Type'].select.name;
  }

  // Extract last contact
  if (props['Last Contact']?.date) {
    data.last_contact = props['Last Contact'].date.start;
  } else if (props['Last Contacted']?.date) {
    data.last_contact = props['Last Contacted'].date.start;
  }

  // Extract related items
  if (props['Projects']?.relation) {
    data.projects = props['Projects'].relation.map(r => r.id);
  }
  if (props['Action Items (Tasks)']?.relation) {
    data.tasks = props['Action Items (Tasks)'].relation.map(r => r.id);
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

      case 'divider':
        markdown += '---\n\n';
        break;
    }
  }

  return markdown;
}

function createEnrichedContent(notionId, data, blocks, originalName) {
  const content = convertBlocksToMarkdown(blocks);
  const name = data.name || originalName;

  const frontmatter = [
    '---',
    `notion_id: "${notionId}"`,
    `name: "${name.replace(/"/g, '\\"')}"`,
    `migration_status: enriched`,
    data.email ? `email: "${data.email}"` : '',
    data.phone ? `phone: "${data.phone}"` : '',
    data.location ? `location: "${data.location}"` : '',
    data.company ? `company: "${data.company}"` : '',
    data.relationship ? `relationship: "${data.relationship}"` : '',
    data.last_contact ? `last_contact: "${data.last_contact}"` : '',
    `created_time: "${data.created_time}"`,
    `last_edited_time: "${data.last_edited_time}"`,
    `notion_url: "${data.url}"`,
    data.projects.length > 0 ? `related_projects: ${data.projects.length}` : '',
    data.tasks.length > 0 ? `related_tasks: ${data.tasks.length}` : '',
    '---'
  ].filter(line => line && !line.includes(': ""')).join('\n');

  const body = [
    '',
    `# ${name}`,
    '',
    '## Contact Information',
    '',
    data.email ? `**Email:** ${data.email}` : '',
    data.phone ? `**Phone:** ${data.phone}` : '',
    data.location ? `**Location:** ${data.location}` : '',
    data.company ? `**Company:** ${data.company}` : '',
    data.relationship ? `**Relationship:** ${data.relationship}` : '',
    data.last_contact ? `**Last Contact:** ${new Date(data.last_contact).toLocaleDateString()}` : '',
    '',
    content ? '## Notes\n\n' + content : '',
    '',
    data.projects.length > 0 ? `## Related Projects (${data.projects.length})\n\n*Project IDs preserved for cross-referencing*\n` : '',
    data.tasks.length > 0 ? `## Related Tasks (${data.tasks.length})\n\n*Task IDs preserved for cross-referencing*\n` : '',
    '',
    '---',
    `*Enriched from Notion on ${new Date().toISOString().split('T')[0]}*`,
    ''
  ].filter(line => line !== null && line !== '').join('\n');

  return frontmatter + body;
}

function filenameToName(filename) {
  // Remove .md and convert kebab-case to proper name
  const name = filename.replace('.md', '');
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function main() {
  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n🚀 Direct People Database Enrichment\n'));

  const notion = new Client({ auth: notionToken });

  try {
    const peopleFiles = await getAllPeopleFiles();
    console.log(chalk.yellow(`Found ${peopleFiles.length} people files\n`));

    let enriched = 0;
    let skipped = 0;
    let failed = 0;

    for (const filename of peopleFiles) {
      const { filepath, content } = await readPersonFile(filename);

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

      const result = await fetchPersonFromNotion(notion, notionId);
      if (!result) {
        console.log(chalk.red(' ✗'));
        failed++;
        continue;
      }

      const data = extractPersonData(result.page);
      const originalName = filenameToName(filename);
      const enrichedContent = createEnrichedContent(notionId, data, result.blocks, originalName);

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