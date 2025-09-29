#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

async function getTaskFromNotion(taskId) {
  try {
    const page = await notion.pages.retrieve({
      page_id: taskId
    });

    // Get the title from "Action Item" property
    const titleArray = page.properties?.['Action Item']?.title || [];
    const title = titleArray.map(t => t.plain_text).join('');

    // Get the status - check if it's Done
    const status = page.properties?.['Status']?.status?.name || '';
    const isDone = status.includes('Done') || status.includes('✅');

    // Get dates
    const createdDate = page.created_time;
    const lastEditedTime = page.last_edited_time;

    // Try to get a completed date from "Do Date" if task is done
    const doDate = page.properties?.['Do Date']?.date?.start || null;
    const completedDate = isDone ? (doDate || lastEditedTime) : null;

    // Get the content blocks
    const blocks = await notion.blocks.children.list({
      block_id: taskId,
      page_size: 100
    });

    return {
      id: taskId,
      title: title,
      isDone: isDone,
      status: status,
      createdDate: createdDate,
      completedDate: completedDate,
      lastEditedTime: lastEditedTime,
      url: page.url,
      blocks: blocks.results
    };
  } catch (error) {
    if (error.code === 'object_not_found') {
      return null;
    }
    throw error;
  }
}

function blocksToMarkdown(blocks) {
  let markdown = '';

  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const text = block.paragraph.rich_text.map(t => t.plain_text).join('');
      markdown += text + '\n\n';
    } else if (block.type === 'bulleted_list_item') {
      const text = block.bulleted_list_item.rich_text.map(t => t.plain_text).join('');
      markdown += '- ' + text + '\n';
    } else if (block.type === 'numbered_list_item') {
      const text = block.numbered_list_item.rich_text.map(t => t.plain_text).join('');
      markdown += '1. ' + text + '\n';
    } else if (block.type === 'to_do') {
      const text = block.to_do.rich_text.map(t => t.plain_text).join('');
      const checked = block.to_do.checked ? '[x]' : '[ ]';
      markdown += `- ${checked} ${text}\n`;
    } else if (block.type === 'heading_1') {
      const text = block.heading_1.rich_text.map(t => t.plain_text).join('');
      markdown += '# ' + text + '\n\n';
    } else if (block.type === 'heading_2') {
      const text = block.heading_2.rich_text.map(t => t.plain_text).join('');
      markdown += '## ' + text + '\n\n';
    } else if (block.type === 'heading_3') {
      const text = block.heading_3.rich_text.map(t => t.plain_text).join('');
      markdown += '### ' + text + '\n\n';
    } else if (block.type === 'code') {
      const text = block.code.rich_text.map(t => t.plain_text).join('');
      const language = block.code.language || '';
      markdown += '```' + language + '\n' + text + '\n```\n\n';
    } else if (block.type === 'quote') {
      const text = block.quote.rich_text.map(t => t.plain_text).join('');
      markdown += '> ' + text + '\n\n';
    } else if (block.type === 'divider') {
      markdown += '---\n\n';
    }
  }

  return markdown.trim();
}

async function enrichTaskFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Extract notion_id from frontmatter
  const notionIdMatch = content.match(/notion_id:\s*"([^"]+)"/);
  if (!notionIdMatch) {
    console.log(`  No notion_id found in ${path.basename(filePath)}`);
    return null;
  }

  const notionId = notionIdMatch[1];

  // Get task data from Notion
  const taskData = await getTaskFromNotion(notionId);
  if (!taskData) {
    console.log(`  Task ${notionId} not found in Notion`);
    return null;
  }

  // Build new frontmatter
  let frontmatter = '---\n';
  frontmatter += `notion_id: "${notionId}"\n`;
  frontmatter += `notion_title: "${taskData.title.replace(/"/g, '\\"')}"\n`;
  frontmatter += `migration_status: enriched\n`;
  frontmatter += `notion_done: ${taskData.isDone}\n`;
  frontmatter += `notion_status: "${taskData.status}"\n`;
  if (taskData.completedDate) {
    frontmatter += `notion_completed_date: "${taskData.completedDate}"\n`;
  }
  frontmatter += `created_time: "${taskData.createdDate}"\n`;
  frontmatter += `last_edited_time: "${taskData.lastEditedTime}"\n`;
  frontmatter += `notion_url: "${taskData.url}"\n`;
  frontmatter += '---\n';

  // Build content
  let newContent = frontmatter;
  newContent += `# ${taskData.title}\n\n`;

  // Add status if it's meaningful
  if (taskData.status && taskData.status !== 'Off Stage') {
    newContent += `**Status:** ${taskData.status}\n\n`;
  }

  const markdownContent = blocksToMarkdown(taskData.blocks);
  if (markdownContent) {
    newContent += markdownContent + '\n';
  }

  // Write back the enriched content
  fs.writeFileSync(filePath, newContent, 'utf8');

  return {
    file: path.basename(filePath),
    done: taskData.isDone,
    status: taskData.status,
    title: taskData.title
  };
}

async function main() {
  // Test with a single file first
  const testFile = 'vault/notion-migration/tasks/2b-or-not-to-b-healthy-the-answer-is-60-off-vitamins-13277.md';

  console.log(`Testing enrichment on ${testFile}...`);

  try {
    const result = await enrichTaskFile(testFile);
    if (result) {
      console.log('✓ Successfully enriched file:');
      console.log(`  Title: ${result.title}`);
      console.log(`  Status: ${result.status}`);
      console.log(`  Done: ${result.done}`);

      // Show the enriched content
      console.log('\n=== ENRICHED CONTENT ===');
      const enrichedContent = fs.readFileSync(testFile, 'utf8');
      console.log(enrichedContent.slice(0, 500));
      console.log('...');
    } else {
      console.log('Failed to enrich file');
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});