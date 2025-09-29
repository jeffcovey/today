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

    return {
      id: taskId,
      name: name,
      isDone: isDone,
      createdDate: createdDate,
      completedDate: completedDate,
      lastEditedTime: page.last_edited_time,
      url: page.url
    };
  } catch (error) {
    if (error.code === 'object_not_found') {
      return null;
    }
    throw error;
  }
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

  // Update the frontmatter with status
  let updatedContent = content;

  // Add or update notion_done status
  if (!content.includes('notion_done:')) {
    // Add after notion_id
    updatedContent = updatedContent.replace(
      /notion_id:\s*"[^"]+"/,
      `$&\nnotion_done: ${taskData.isDone}`
    );
  } else {
    // Update existing
    updatedContent = updatedContent.replace(
      /notion_done:\s*\w+/,
      `notion_done: ${taskData.isDone}`
    );
  }

  // Add completed date if done and not already present
  if (taskData.isDone && taskData.completedDate && !content.includes('notion_completed_date:')) {
    updatedContent = updatedContent.replace(
      /notion_done:\s*\w+/,
      `$&\nnotion_completed_date: "${taskData.completedDate}"`
    );
  }

  // Add last edited time
  if (!content.includes('notion_last_edited:')) {
    updatedContent = updatedContent.replace(
      /notion_done:\s*\w+/,
      `$&\nnotion_last_edited: "${taskData.lastEditedTime}"`
    );
  }

  // Write back the updated content
  fs.writeFileSync(filePath, updatedContent, 'utf8');

  return {
    file: path.basename(filePath),
    done: taskData.isDone,
    name: taskData.name
  };
}

async function processTaskBatch(taskFiles, startIdx, batchSize) {
  const batch = taskFiles.slice(startIdx, startIdx + batchSize);
  const results = {
    done: [],
    pending: [],
    notFound: [],
    errors: []
  };

  for (const file of batch) {
    const filePath = path.join('vault/notion-migration/tasks', file);
    try {
      const result = await enrichTaskFile(filePath);
      if (result) {
        if (result.done) {
          results.done.push(result);
        } else {
          results.pending.push(result);
        }
      } else {
        results.notFound.push(file);
      }
    } catch (error) {
      console.error(`Error processing ${file}:`, error.message);
      results.errors.push(file);
    }

    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 100));
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
  console.log(`✅ Done tasks: ${results.done.length}`);
  console.log(`⏳ Pending tasks: ${results.pending.length}`);
  console.log(`❌ Not found in Notion: ${results.notFound.length}`);
  console.log(`⚠️ Errors: ${results.errors.length}`);

  if (results.done.length > 0) {
    console.log('\nCompleted tasks:');
    results.done.forEach(t => console.log(`  ✅ ${t.file}: ${t.name}`));
  }

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