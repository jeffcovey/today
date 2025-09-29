#!/usr/bin/env node

import { Client } from '@notionhq/client';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

async function enrichSingleTask(filePath) {
  console.log(`Enriching task: ${filePath}`);

  // Read the file
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');

  // Extract notion_id from frontmatter
  const idMatch = content.match(/^notion_id:\s*"([^"]+)"/m);
  if (!idMatch) {
    console.log('No notion_id found in file');
    return;
  }

  const notionId = idMatch[1];
  console.log(`Fetching Notion page: ${notionId}`);

  try {
    // Fetch the page from Notion
    const page = await notion.pages.retrieve({
      page_id: notionId
    });

    // Get the blocks (content) of the page
    const blocks = await notion.blocks.children.list({
      block_id: notionId,
      page_size: 100
    });

    console.log('\n=== PAGE PROPERTIES ===');
    console.log(JSON.stringify(page.properties, null, 2));

    console.log('\n=== PAGE CONTENT BLOCKS ===');
    console.log(`Found ${blocks.results.length} blocks`);

    // Extract text content from blocks
    let textContent = [];
    for (const block of blocks.results) {
      if (block.type === 'paragraph' && block.paragraph?.rich_text?.length > 0) {
        const text = block.paragraph.rich_text.map(t => t.plain_text).join('');
        if (text.trim()) {
          textContent.push(text);
        }
      } else if (block.type === 'bulleted_list_item' && block.bulleted_list_item?.rich_text?.length > 0) {
        const text = block.bulleted_list_item.rich_text.map(t => t.plain_text).join('');
        if (text.trim()) {
          textContent.push(`• ${text}`);
        }
      } else if (block.type === 'numbered_list_item' && block.numbered_list_item?.rich_text?.length > 0) {
        const text = block.numbered_list_item.rich_text.map(t => t.plain_text).join('');
        if (text.trim()) {
          textContent.push(`1. ${text}`);
        }
      } else if (block.type === 'to_do' && block.to_do?.rich_text?.length > 0) {
        const text = block.to_do.rich_text.map(t => t.plain_text).join('');
        const checked = block.to_do.checked ? 'x' : ' ';
        if (text.trim()) {
          textContent.push(`- [${checked}] ${text}`);
        }
      }
    }

    console.log('\n=== EXTRACTED TEXT CONTENT ===');
    if (textContent.length > 0) {
      console.log(textContent.join('\n'));
    } else {
      console.log('No text content found in blocks');
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

    // Build the enriched file - preserve existing data and add new
    let enrichedContent = [];

    // Merge frontmatter - existing values take precedence unless we're updating them
    const mergedFrontmatter = { ...existingFrontmatter };

    // Update migration status
    mergedFrontmatter.migration_status = 'enriched';

    // Add new fields from Notion API
    if (!mergedFrontmatter.notion_url) {
      mergedFrontmatter.notion_url = `"${page.url}"`;
    }

    // Add dates if not present
    if (!mergedFrontmatter.notion_do_date && page.properties['Do Date']?.date?.start) {
      mergedFrontmatter.notion_do_date = `"${page.properties['Do Date'].date.start}"`;
    }
    if (!mergedFrontmatter.notion_due_date && page.properties['Due Date']?.date?.start) {
      mergedFrontmatter.notion_due_date = `"${page.properties['Due Date'].date.start}"`;
    }

    // Write frontmatter
    enrichedContent.push('---');
    for (const [key, value] of Object.entries(mergedFrontmatter)) {
      enrichedContent.push(`${key}: ${value}`);
    }
    enrichedContent.push('---');

    // Add title as H1
    if (page.properties.Name?.title?.[0]?.plain_text) {
      enrichedContent.push(`# ${page.properties.Name.title[0].plain_text}`);
      enrichedContent.push('');
    }

    // Add status
    if (page.properties.Status?.select?.name || page.properties.Status?.status?.name) {
      const status = page.properties.Status?.select?.name || page.properties.Status?.status?.name;
      enrichedContent.push(`**Status:** ${status}`);
      enrichedContent.push('');
    }

    // Add content if any
    if (textContent.length > 0) {
      enrichedContent.push('## Content');
      enrichedContent.push('');
      enrichedContent.push(textContent.join('\n'));
      enrichedContent.push('');
    }

    // Save the enriched content back to the original file
    await fs.writeFile(filePath, enrichedContent.join('\n'));

    console.log(`\n=== ENRICHED FILE ===`);
    console.log(`Updated: ${filePath}`);

  } catch (error) {
    console.error('Error fetching from Notion:', error.message);
    if (error.code === 'object_not_found') {
      console.log('This task may have been deleted from Notion');
    }
  }
}

// Run the enrichment
const taskFile = 'vault/notion-migration/tasks/ask-for-the-balcony-upgrade-14286.md';
enrichSingleTask(taskFile).catch(console.error);