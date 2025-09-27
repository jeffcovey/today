#!/usr/bin/env node

/**
 * Universal Enrichment Script - Works for ANY Notion database
 * Dynamically extracts ALL properties without hardcoding field names
 */

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

config();

// Get database directory from command line
const DB_DIR = process.argv[2];
const DB_NAME = process.argv[3] || path.basename(DB_DIR);

if (!DB_DIR) {
  console.error(chalk.red('Usage: node enrich-universal.js <directory> [name]'));
  console.error(chalk.yellow('Example: node enrich-universal.js vault/notion-migration/projects Projects'));
  process.exit(1);
}

async function getAllFiles() {
  try {
    const files = await fs.readdir(DB_DIR);
    return files.filter(f => f.endsWith('.md')).sort();
  } catch (error) {
    console.error(chalk.red(`Cannot read directory ${DB_DIR}: ${error.message}`));
    process.exit(1);
  }
}

async function readFile(filename) {
  const filepath = path.join(DB_DIR, filename);
  const content = await fs.readFile(filepath, 'utf-8');
  return { filepath, content };
}

function extractNotionId(content) {
  const match = content.match(/notion_id:\s*"?([a-f0-9-]+)"?/);
  return match ? match[1] : null;
}

async function fetchFromNotion(notion, pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const blocks = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100
    });
    return { page, blocks: blocks.results };
  } catch (error) {
    console.error(chalk.red(`Error fetching ${pageId}: ${error.message}`));
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
      case 'phone_number':
        data.properties[key] = value.phone_number || '';
        break;
      case 'formula':
        if (value.formula?.type === 'string') {
          data.properties[key] = value.formula.string || '';
        } else if (value.formula?.type === 'number') {
          data.properties[key] = value.formula.number;
        } else if (value.formula?.type === 'boolean') {
          data.properties[key] = value.formula.boolean;
        } else if (value.formula?.type === 'date') {
          data.properties[key] = value.formula.date?.start || '';
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
      case 'files':
        data.properties[key] = value.files?.map(f => f.file?.url || f.external?.url || '') || [];
        break;
      case 'people':
        data.properties[key] = value.people?.map(p => p.name || p.email || '') || [];
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
        if (toggle) markdown += `<details><summary>${toggle}</summary></details>\n\n`;
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

      case 'callout':
        const icon = block.callout?.icon?.emoji || '💡';
        const callout = block.callout?.rich_text?.map(t => t.plain_text).join('') || '';
        if (callout) markdown += `> ${icon} ${callout}\n\n`;
        break;

      case 'divider':
        markdown += '---\n\n';
        break;

      case 'image':
        const imageUrl = block.image?.file?.url || block.image?.external?.url;
        const caption = block.image?.caption?.map(t => t.plain_text).join('') || '';
        if (imageUrl) {
          markdown += `![${caption}](${imageUrl})\n`;
          if (caption) markdown += `*${caption}*\n`;
          markdown += '\n';
        }
        break;

      case 'video':
        const videoUrl = block.video?.file?.url || block.video?.external?.url;
        if (videoUrl) markdown += `[Video](${videoUrl})\n\n`;
        break;

      case 'file':
        const fileUrl = block.file?.file?.url || block.file?.external?.url;
        const fileName = block.file?.caption?.map(t => t.plain_text).join('') || 'File';
        if (fileUrl) markdown += `[${fileName}](${fileUrl})\n\n`;
        break;

      case 'bookmark':
        const bookmarkUrl = block.bookmark?.url;
        const bookmarkCaption = block.bookmark?.caption?.map(t => t.plain_text).join('') || bookmarkUrl;
        if (bookmarkUrl) markdown += `[${bookmarkCaption}](${bookmarkUrl})\n\n`;
        break;

      case 'table':
        // Tables are complex - just note their presence
        markdown += '*[Table content not fully rendered]*\n\n';
        break;
    }
  }

  return markdown;
}

function sanitizeYamlValue(value) {
  if (typeof value === 'string') {
    // Escape quotes and newlines for YAML
    return `"${value.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}

function createEnrichedContent(notionId, data, blocks, filename) {
  const content = convertBlocksToMarkdown(blocks);
  const props = data.properties;

  // Find the title property (usually "Name", "Title", or the first title-type property)
  let title = '';
  for (const [key, value] of Object.entries(props)) {
    if (key === 'Title' || key === 'Name' || key === 'title') {
      title = value;
      break;
    }
  }
  // If no title found, look for any property that looks like a title
  if (!title) {
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'string' && value && !value.includes('http')) {
        title = value;
        break;
      }
    }
  }
  // Fallback to filename
  if (!title) {
    title = filename.replace('.md', '').split('-').map(w =>
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }

  // Build frontmatter
  const frontmatterItems = [
    '---',
    `notion_id: "${notionId}"`,
    `title: ${sanitizeYamlValue(title)}`,
    `migration_status: enriched`
  ];

  // Add all properties to frontmatter
  for (const [key, value] of Object.entries(props)) {
    // Skip if already added
    if (key === 'Title' || key === 'Name' || key === 'title') continue;

    // Convert property name to valid YAML key
    const yamlKey = key.toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');

    if (Array.isArray(value)) {
      if (value.length > 0) {
        if (typeof value[0] === 'string') {
          frontmatterItems.push(`${yamlKey}: [${value.map(v => sanitizeYamlValue(v)).join(', ')}]`);
        } else {
          frontmatterItems.push(`${yamlKey}_count: ${value.length}`);
        }
      }
    } else if (value !== null && value !== undefined && value !== '') {
      frontmatterItems.push(`${yamlKey}: ${sanitizeYamlValue(value)}`);
    }
  }

  // Add metadata
  frontmatterItems.push(`created_time: "${data.created_time}"`);
  frontmatterItems.push(`last_edited_time: "${data.last_edited_time}"`);
  frontmatterItems.push(`notion_url: "${data.url}"`);
  frontmatterItems.push('---');

  const frontmatter = frontmatterItems.join('\n');

  // Build body
  const bodyParts = ['', `# ${title}`, ''];

  // Add properties section if there are meaningful properties
  const displayProps = Object.entries(props).filter(([key, value]) => {
    return value && value !== '' && !['Title', 'Name', 'title'].includes(key);
  });

  if (displayProps.length > 0) {
    bodyParts.push('## Properties');
    bodyParts.push('');

    for (const [key, value] of displayProps) {
      if (Array.isArray(value)) {
        if (value.length > 0 && typeof value[0] === 'string') {
          bodyParts.push(`**${key}:** ${value.join(', ')}`);
        } else if (value.length > 0) {
          bodyParts.push(`**${key}:** ${value.length} items`);
        }
      } else if (typeof value === 'boolean') {
        bodyParts.push(`**${key}:** ${value ? '✅' : '❌'}`);
      } else if (typeof value === 'number') {
        if (key.includes('%') || key.includes('percent')) {
          bodyParts.push(`**${key}:** ${Math.round(value * 100)}%`);
        } else {
          bodyParts.push(`**${key}:** ${value}`);
        }
      } else if (value) {
        bodyParts.push(`**${key}:** ${value}`);
      }
    }
    bodyParts.push('');
  }

  // Add content
  if (content) {
    bodyParts.push('## Content');
    bodyParts.push('');
    bodyParts.push(content);
  }

  // Add footer
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

  console.log(chalk.cyan.bold(`\n🚀 Universal Enrichment - ${DB_NAME}\n`));

  const notion = new Client({ auth: notionToken });

  try {
    const files = await getAllFiles();
    console.log(chalk.yellow(`Found ${files.length} files in ${DB_DIR}\n`));

    let enriched = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < files.length; i++) {
      const filename = files[i];
      const { filepath, content } = await readFile(filename);

      // Show progress every 10 files
      if (i > 0 && i % 10 === 0) {
        console.log(chalk.blue(`Progress: ${i}/${files.length} files processed`));
      }

      const notionId = extractNotionId(content);
      if (!notionId) {
        console.log(chalk.gray(`  No Notion ID in ${filename}`));
        failed++;
        continue;
      }

      process.stdout.write(`  Enriching ${filename}...`);

      const result = await fetchFromNotion(notion, notionId);
      if (!result) {
        console.log(chalk.red(' ✗'));
        failed++;
        continue;
      }

      const data = extractAllProperties(result.page);
      const enrichedContent = createEnrichedContent(notionId, data, result.blocks, filename);

      await fs.writeFile(filepath, enrichedContent, 'utf-8');
      console.log(chalk.green(' ✓'));
      enriched++;

      // Rate limiting delay
      await new Promise(resolve => setTimeout(resolve, 100));
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