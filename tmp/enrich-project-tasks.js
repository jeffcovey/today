#!/usr/bin/env node

import { Client } from '@notionhq/client';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

// Task IDs from the 2022 Thanksgiving Cruise project
const taskIds = [
  "b8aaae84-bb7d-486a-9ec0-0ce7c51b0860",
  "ffb2d1b6-56ec-4d08-88f0-137987770702",
  "01d92ac5-ca73-45b0-8550-21ac290688e9",
  "45b45896-b727-490f-8807-d8ec52fa6b33",
  "aa74cebb-0bee-4231-bf14-016a26dc9632",
  "221c96a1-13d8-4fe3-abba-b21fad2bfda7",
  "96967f71-4524-4053-86b7-d86659c1ff7c",
  "f37804c7-e2a8-4161-9569-ca5fdc658ac9",
  "9fea3fc7-b8f4-4179-9b08-0d5c2aa45993",
  "e3189efa-db04-44c2-b207-49863481ad3d",
  "b4025f1c-380d-4a88-bed0-6cd4946f2a51",
  "10ceb46d-b542-4c2e-a5ca-0a2d3435f67b",
  "4c29027e-1551-4606-be2a-731d2eaed6a0",
  "1643fde6-b27a-4cac-b044-91c0d51a678b",
  "da1be7f2-559a-4c8c-b3dc-e388f5bae4a2",
  "c8716f71-aea5-4e9e-9d1e-3c0a19b259ad",
  "60f32bb5-ed33-4172-a7fa-401f67cb6bc2",
  "3d479616-a0d4-4210-8f5e-5836a8501ec8",
  "619240e8-784d-4452-ac74-8e8223d08ad1",
  "302efdbc-efbe-4d01-9e81-17184f44be80",
  "5a8ba559-410a-4f8d-95b7-2669ab34a142",
  "afd251ce-068d-4acb-a1d2-b75df663535e",
  "a378437b-f53d-4251-b33d-3e27d753407c",
  "6284a986-2a47-44ca-a129-cf7431dfa2a1",
  "49b41f78-4cd5-485f-b4fa-4d23c4bba7f8"
];

async function findTaskFile(notionId) {
  const tasksDir = 'vault/notion-migration/tasks';
  const files = await fs.readdir(tasksDir);

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const content = await fs.readFile(path.join(tasksDir, file), 'utf-8');
    if (content.includes(`notion_id: "${notionId}"`)) {
      return path.join(tasksDir, file);
    }
  }
  return null;
}

async function enrichTask(filePath, notionId) {
  try {
    // Read existing file
    const content = await fs.readFile(filePath, 'utf-8');

    // Skip if already enriched
    if (content.includes('migration_status: enriched')) {
      console.log(`  Already enriched, skipping`);
      return { status: 'already_enriched' };
    }

    // Fetch from Notion
    const page = await notion.pages.retrieve({ page_id: notionId });

    // Get content blocks
    const blocks = await notion.blocks.children.list({
      block_id: notionId,
      page_size: 100
    });

    // Extract text content
    let textContent = [];
    for (const block of blocks.results) {
      if (block.type === 'paragraph' && block.paragraph?.rich_text?.length > 0) {
        const text = block.paragraph.rich_text.map(t => t.plain_text).join('');
        if (text.trim()) textContent.push(text);
      } else if (block.type === 'bulleted_list_item' && block.bulleted_list_item?.rich_text?.length > 0) {
        const text = block.bulleted_list_item.rich_text.map(t => t.plain_text).join('');
        if (text.trim()) textContent.push(`• ${text}`);
      } else if (block.type === 'to_do' && block.to_do?.rich_text?.length > 0) {
        const text = block.to_do.rich_text.map(t => t.plain_text).join('');
        const checked = block.to_do.checked ? 'x' : ' ';
        if (text.trim()) textContent.push(`- [${checked}] ${text}`);
      }
    }

    // Parse existing frontmatter
    let frontmatterEnd = content.indexOf('---', 4);
    let existingFrontmatter = {};
    if (frontmatterEnd > 0) {
      const frontmatterLines = content.substring(4, frontmatterEnd).split('\n');
      for (const line of frontmatterLines) {
        const match = line.match(/^([^:]+):\s*(.+)$/);
        if (match) {
          existingFrontmatter[match[1].trim()] = match[2].trim();
        }
      }
    }

    // Merge frontmatter
    const mergedFrontmatter = { ...existingFrontmatter };
    mergedFrontmatter.migration_status = 'enriched';
    if (!mergedFrontmatter.notion_url) {
      mergedFrontmatter.notion_url = `"${page.url}"`;
    }

    // Build enriched content
    let enrichedContent = [];
    enrichedContent.push('---');
    for (const [key, value] of Object.entries(mergedFrontmatter)) {
      enrichedContent.push(`${key}: ${value}`);
    }
    enrichedContent.push('---');

    // Add title
    const title = existingFrontmatter.notion_title?.replace(/"/g, '') ||
                  page.properties.Name?.title?.[0]?.plain_text ||
                  'Untitled';
    enrichedContent.push(`# ${title}`);

    // Add status
    const status = existingFrontmatter.notion_status?.replace(/"/g, '') ||
                   page.properties.Status?.status?.name ||
                   page.properties.Status?.select?.name;
    if (status) {
      enrichedContent.push(`**Status:** ${status}`);
    }

    // Add content if any
    if (textContent.length > 0) {
      enrichedContent.push('');
      enrichedContent.push('## Content');
      enrichedContent.push('');
      enrichedContent.push(textContent.join('\n'));
    } else {
      enrichedContent.push('*No additional content*');
    }

    // Save enriched file
    await fs.writeFile(filePath, enrichedContent.join('\n'));

    return {
      status: 'enriched',
      hasContent: textContent.length > 0,
      contentLength: textContent.join('\n').length
    };

  } catch (error) {
    console.log(`  Error: ${error.message}`);
    return { status: 'error', error: error.message };
  }
}

async function main() {
  console.log('Enriching 25 tasks for 2022 Thanksgiving Cruise project...\n');

  let stats = {
    found: 0,
    notFound: 0,
    enriched: 0,
    alreadyEnriched: 0,
    errors: 0,
    withContent: 0,
    withoutContent: 0
  };

  for (let i = 0; i < taskIds.length; i++) {
    const notionId = taskIds[i];
    console.log(`${i + 1}/${taskIds.length}: Processing ${notionId}`);

    const filePath = await findTaskFile(notionId);
    if (!filePath) {
      console.log(`  File not found`);
      stats.notFound++;
      continue;
    }

    console.log(`  Found: ${path.basename(filePath)}`);
    stats.found++;

    const result = await enrichTask(filePath, notionId);

    if (result.status === 'enriched') {
      stats.enriched++;
      if (result.hasContent) {
        stats.withContent++;
        console.log(`  ✓ Enriched with ${result.contentLength} chars of content`);
      } else {
        stats.withoutContent++;
        console.log(`  ✓ Enriched (no content)`);
      }
    } else if (result.status === 'already_enriched') {
      stats.alreadyEnriched++;
    } else if (result.status === 'error') {
      stats.errors++;
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log('\n=== Summary ===');
  console.log(`Files found: ${stats.found}/${taskIds.length}`);
  console.log(`Newly enriched: ${stats.enriched}`);
  console.log(`Already enriched: ${stats.alreadyEnriched}`);
  console.log(`With content: ${stats.withContent}`);
  console.log(`Without content: ${stats.withoutContent}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Not found: ${stats.notFound}`);
}

main().catch(console.error);