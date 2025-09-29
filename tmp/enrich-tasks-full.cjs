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

    // Get the checkbox status
    const isDone = page.properties?.['Done']?.checkbox || false;

    // Get the task name
    const nameArray = page.properties?.['Task Name']?.title || [];
    const name = nameArray.map(t => t.plain_text).join('');

    // Get dates
    const createdDate = page.properties?.['Created time']?.created_time;
    const completedDate = page.properties?.['Completed time']?.date?.start;

    // Get the content
    const blocks = await notion.blocks.children.list({
      block_id: taskId,
      page_size: 100
    });

    return {
      id: taskId,
      name: name,
      isDone: isDone,
      createdDate: createdDate,
      completedDate: completedDate,
      lastEditedTime: page.last_edited_time,
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
  frontmatter += `notion_title: "${taskData.name.replace(/"/g, '\\"')}"\n`;
  frontmatter += `migration_status: enriched\n`;
  frontmatter += `notion_done: ${taskData.isDone}\n`;
  if (taskData.completedDate) {
    frontmatter += `notion_completed_date: "${taskData.completedDate}"\n`;
  }
  frontmatter += `created_time: "${taskData.createdDate}"\n`;
  frontmatter += `last_edited_time: "${taskData.lastEditedTime}"\n`;
  frontmatter += `notion_url: "${taskData.url}"\n`;
  frontmatter += '---\n';

  // Build content
  let newContent = frontmatter;
  newContent += `# ${taskData.name}\n\n`;

  const markdownContent = blocksToMarkdown(taskData.blocks);
  if (markdownContent) {
    newContent += markdownContent + '\n';
  }

  // Write back the enriched content
  fs.writeFileSync(filePath, newContent, 'utf8');

  return {
    file: path.basename(filePath),
    done: taskData.isDone,
    name: taskData.name
  };
}

async function processTaskBatch(taskFiles, startIdx, batchSize) {
  const batch = taskFiles.slice(startIdx, startIdx + batchSize);
  const results = {
    enriched: [],
    notFound: [],
    errors: []
  };

  for (const file of batch) {
    const filePath = path.join('vault/notion-migration/tasks', file);
    try {
      const result = await enrichTaskFile(filePath);
      if (result) {
        results.enriched.push(result);
        console.log(`  ✓ Enriched: ${result.file}`);
      } else {
        results.notFound.push(file);
      }
    } catch (error) {
      console.error(`  ✗ Error processing ${file}:`, error.message);
      results.errors.push(file);
    }

    // Delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return results;
}

async function main() {
  const tasksDir = 'vault/notion-migration/tasks';

  // Get batch parameters from command line
  const batchSize = parseInt(process.argv[2]) || 50;
  const batchNumber = parseInt(process.argv[3]) || 1;

  // Get all task files
  const allFiles = fs.readdirSync(tasksDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  const totalFiles = allFiles.length;
  const startIdx = (batchNumber - 1) * batchSize;
  const endIdx = Math.min(startIdx + batchSize, totalFiles);

  console.log(`Processing batch ${batchNumber} (files ${startIdx + 1}-${endIdx} of ${totalFiles})`);
  console.log('---');

  if (startIdx >= totalFiles) {
    console.log('No more files to process');
    return;
  }

  const results = await processTaskBatch(allFiles, startIdx, batchSize);

  console.log('\n=== RESULTS ===');
  console.log(`✅ Enriched: ${results.enriched.length}`);
  console.log(`❌ Not found in Notion: ${results.notFound.length}`);
  console.log(`⚠️ Errors: ${results.errors.length}`);

  const totalBatches = Math.ceil(totalFiles / batchSize);
  if (batchNumber < totalBatches) {
    console.log(`\nNext batch: node ${process.argv[1]} ${batchSize} ${batchNumber + 1}`);
  } else {
    console.log('\nAll batches processed!');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});