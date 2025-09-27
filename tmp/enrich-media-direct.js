#!/usr/bin/env node

/**
 * Direct Media Vault Database Enrichment - Fetches full content from Notion
 * Processes 157 media files
 */

import { config } from 'dotenv';
import { Client } from '@notionhq/client';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

config();

const MEDIA_DIR = 'vault/notion-migration/media';

async function getAllMediaFiles() {
  const files = await fs.readdir(MEDIA_DIR);
  return files.filter(f => f.endsWith('.md')).sort();
}

async function readMediaFile(filename) {
  const filepath = path.join(MEDIA_DIR, filename);
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

async function fetchMediaFromNotion(notion, mediaId) {
  try {
    // Get the page
    const page = await notion.pages.retrieve({ page_id: mediaId });

    // Get the page content (blocks)
    const blocks = await notion.blocks.children.list({
      block_id: mediaId,
      page_size: 100
    });

    return { page, blocks: blocks.results };
  } catch (error) {
    console.error(chalk.red(`Error fetching ${mediaId}: ${error.message}`));
    return null;
  }
}

function extractMediaData(page) {
  const props = page.properties || {};
  const data = {
    title: '',
    type: '',
    category: '',
    tags: [],
    source: '',
    author: '',
    date: '',
    rating: '',
    status: '',
    notes: '',
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    related_projects: [],
    file_url: ''
  };

  // Extract title
  if (props['Title']?.title?.[0]) {
    data.title = props['Title'].title[0].plain_text;
  } else if (props['Name']?.title?.[0]) {
    data.title = props['Name'].title[0].plain_text;
  } else if (props['Media']?.title?.[0]) {
    data.title = props['Media'].title[0].plain_text;
  }

  // Extract type (movie, book, article, video, etc.)
  if (props['Type']?.select) {
    data.type = props['Type'].select.name;
  } else if (props['Media Type']?.select) {
    data.type = props['Media Type'].select.name;
  }

  // Extract category
  if (props['Category']?.select) {
    data.category = props['Category'].select.name;
  } else if (props['Genre']?.select) {
    data.category = props['Genre'].select.name;
  }

  // Extract tags
  if (props['Tags']?.multi_select) {
    data.tags = props['Tags'].multi_select.map(tag => tag.name);
  }

  // Extract source/URL
  if (props['Source']?.url) {
    data.source = props['Source'].url;
  } else if (props['Link']?.url) {
    data.source = props['Link'].url;
  } else if (props['URL']?.url) {
    data.source = props['URL'].url;
  }

  // Extract author/creator
  if (props['Author']?.rich_text?.[0]) {
    data.author = props['Author'].rich_text[0].plain_text;
  } else if (props['Creator']?.rich_text?.[0]) {
    data.author = props['Creator'].rich_text[0].plain_text;
  } else if (props['Director']?.rich_text?.[0]) {
    data.author = props['Director'].rich_text[0].plain_text;
  }

  // Extract date
  if (props['Date']?.date) {
    data.date = props['Date'].date.start;
  } else if (props['Published']?.date) {
    data.date = props['Published'].date.start;
  } else if (props['Released']?.date) {
    data.date = props['Released'].date.start;
  } else if (props['Watched']?.date) {
    data.date = props['Watched'].date.start;
  } else if (props['Read']?.date) {
    data.date = props['Read'].date.start;
  }

  // Extract rating
  if (props['Rating']?.number) {
    data.rating = props['Rating'].number;
  } else if (props['Score']?.number) {
    data.rating = props['Score'].number;
  } else if (props['Stars']?.number) {
    data.rating = props['Stars'].number;
  }

  // Extract status
  if (props['Status']?.select) {
    data.status = props['Status'].select.name;
  }

  // Extract file URL if present
  if (props['File']?.files?.[0]) {
    data.file_url = props['File'].files[0].file?.url || props['File'].files[0].external?.url || '';
  }

  // Extract related projects
  if (props['Projects']?.relation) {
    data.related_projects = props['Projects'].relation.map(r => r.id);
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

      case 'bookmark':
        const bookmarkUrl = block.bookmark?.url;
        if (bookmarkUrl) markdown += `[Bookmark](${bookmarkUrl})\n\n`;
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
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
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
    data.type ? `type: "${data.type}"` : '',
    data.category ? `category: "${data.category}"` : '',
    data.tags.length > 0 ? `tags: [${data.tags.map(t => `"${t}"`).join(', ')}]` : '',
    data.source ? `source: "${data.source}"` : '',
    data.author ? `author: "${data.author}"` : '',
    data.date ? `date: "${data.date}"` : '',
    data.rating ? `rating: ${data.rating}` : '',
    data.status ? `status: "${data.status}"` : '',
    data.file_url ? `file_url: "${data.file_url}"` : '',
    `created_time: "${data.created_time}"`,
    `last_edited_time: "${data.last_edited_time}"`,
    `notion_url: "${data.url}"`,
    data.related_projects.length > 0 ? `related_projects: ${data.related_projects.length}` : '',
    '---'
  ].filter(line => line && !line.includes(': ""')).join('\n');

  const body = [
    '',
    `# ${title}`,
    '',
    '## Media Details',
    '',
    data.type ? `**Type:** ${data.type}` : '',
    data.category ? `**Category:** ${data.category}` : '',
    data.author ? `**Author/Creator:** ${data.author}` : '',
    data.date ? `**Date:** ${new Date(data.date).toLocaleDateString()}` : '',
    data.rating ? `**Rating:** ${data.rating}` : '',
    data.status ? `**Status:** ${data.status}` : '',
    data.tags.length > 0 ? `**Tags:** ${data.tags.join(', ')}` : '',
    data.source ? `**Source:** [Link](${data.source})` : '',
    data.file_url ? `**File:** [Download](${data.file_url})` : '',
    '',
    '## Content',
    '',
    content || '*No content*',
    '',
    data.related_projects.length > 0 ? `## Related Projects (${data.related_projects.length})\n\n*Project IDs preserved for cross-referencing*\n` : '',
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

  console.log(chalk.cyan.bold('\n🚀 Direct Media Vault Database Enrichment\n'));

  const notion = new Client({ auth: notionToken });

  try {
    const mediaFiles = await getAllMediaFiles();
    console.log(chalk.yellow(`Found ${mediaFiles.length} media files\n`));

    let enriched = 0;
    let skipped = 0;
    let failed = 0;

    for (const filename of mediaFiles) {
      const { filepath, content } = await readMediaFile(filename);

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

      const result = await fetchMediaFromNotion(notion, notionId);
      if (!result) {
        console.log(chalk.red(' ✗'));
        failed++;
        continue;
      }

      const data = extractMediaData(result.page);
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