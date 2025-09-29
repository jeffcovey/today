#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function convertDaysToRecurring(days) {
  if (!days || days <= 0) return null;

  // Convert days to Obsidian Tasks recurring syntax
  // Based on https://publish.obsidian.md/tasks/Getting+Started/Recurring+Tasks

  if (days === 1) return 'every day';
  if (days === 7) return 'every week';
  if (days === 14) return 'every 2 weeks';
  if (days === 30 || days === 31) return 'every month';
  if (days === 365 || days === 366) return 'every year';

  // For weekly intervals
  if (days % 7 === 0) {
    const weeks = days / 7;
    return `every ${weeks} weeks`;
  }

  // For monthly intervals (approximate)
  if (days % 30 === 0) {
    const months = days / 30;
    return `every ${months} months`;
  }

  // For any other number of days
  return `every ${days} days`;
}

async function processRepeatingTask(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // Parse frontmatter
    const parts = content.split('---\n');
    if (parts.length < 3) {
      console.log(`  ⚠️ Invalid frontmatter: ${path.basename(filePath)}`);
      return null;
    }

    const frontmatter = parts[1];

    // Extract notion_id and title
    const notionId = frontmatter.match(/notion_id:\s*"([^"]+)"/)?.[1];
    const title = frontmatter.match(/notion_title:\s*"([^"]+)"/)?.[1] || '';
    const createdTime = frontmatter.match(/created_time:\s*"([^"]+)"/)?.[1];

    if (!notionId || !title) {
      console.log(`  ⚠️ Missing required fields: ${path.basename(filePath)}`);
      return null;
    }

    // Fetch fresh data from Notion to get "Repeat Every (Days)" property
    console.log(`  🔍 Fetching Notion data for: ${title}`);
    const page = await notion.pages.retrieve({ page_id: notionId });

    // Look for the "Repeat Every (Days)" property
    let repeatDays = null;
    const properties = page.properties;

    // Check various possible property names for repeat interval
    for (const [propName, propValue] of Object.entries(properties)) {
      if (propName.toLowerCase().includes('repeat') && propName.toLowerCase().includes('days')) {
        if (propValue.type === 'number' && propValue.number) {
          repeatDays = propValue.number;
          console.log(`  📅 Found repeat interval: ${repeatDays} days in property "${propName}"`);
          break;
        }
      }
    }

    if (!repeatDays) {
      console.log(`  ⚠️ No repeat interval found for: ${title}`);
      console.log(`  📋 Available properties: ${Object.keys(properties).join(', ')}`);
      return null;
    }

    // Convert to Obsidian recurring syntax
    const recurringText = convertDaysToRecurring(repeatDays);
    if (!recurringText) {
      console.log(`  ⚠️ Could not convert ${repeatDays} days to recurring syntax`);
      return null;
    }

    // Format the task line with recurring syntax
    let taskLine = `- [ ] ${title}`;

    // Add created date
    if (createdTime) {
      const created = new Date(createdTime);
      const createdStr = created.toISOString().split('T')[0];
      taskLine += ` ➕ ${createdStr}`;
    }

    // Add recurring syntax
    taskLine += ` 🔁 ${recurringText}`;

    // Add notion ID as comment
    taskLine += ` <!-- ${notionId} -->`;

    console.log(`  ✓ Converted: ${title} → ${recurringText}`);
    return taskLine;

  } catch (error) {
    console.error(`  ✗ Error processing ${path.basename(filePath)}: ${error.message}`);
    return null;
  }
}

async function processInBatches(files, batchSize = 5) {
  const taskLines = [];
  let processedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    console.log(`\n📦 Processing batch ${Math.floor(i/batchSize) + 1} (files ${i+1}-${Math.min(i+batchSize, files.length)} of ${files.length})`);

    const promises = batch.map(file => processRepeatingTask(file));
    const results = await Promise.all(promises);

    for (const result of results) {
      if (result) {
        taskLines.push(result);
        processedCount++;
      } else {
        errorCount++;
      }
    }

    // Small delay between batches to avoid rate limits
    if (i + batchSize < files.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return { taskLines, processedCount, errorCount };
}

async function main() {
  const repeatingDir = 'vault/notion-migration/tasks/repeating';
  const outputFile = 'vault/tasks/repeating.md';
  const processedDir = 'vault/notion-migration/tasks/repeating/processed';

  // Create processed directory if it doesn't exist
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }

  // Create tasks directory if it doesn't exist
  const tasksOutputDir = path.dirname(outputFile);
  if (!fs.existsSync(tasksOutputDir)) {
    fs.mkdirSync(tasksOutputDir, { recursive: true });
  }

  // Get all repeating task files
  const files = fs.readdirSync(repeatingDir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(repeatingDir, f));

  console.log(`Found ${files.length} repeating task files\n`);

  if (files.length === 0) {
    console.log('✅ No repeating task files to process!');
    return;
  }

  // Process files in batches
  const { taskLines, processedCount, errorCount } = await processInBatches(files);

  // Write to repeating.md
  if (taskLines.length > 0) {
    const content = taskLines.join('\n') + '\n';
    fs.writeFileSync(outputFile, content);

    // Move processed files
    let movedCount = 0;
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const notionId = content.match(/notion_id:\s*"([^"]+)"/)?.[1];

        // Only move files that were successfully processed
        if (notionId && taskLines.some(line => line.includes(notionId))) {
          const destPath = path.join(processedDir, path.basename(file));
          fs.renameSync(file, destPath);
          movedCount++;
        }
      } catch (error) {
        console.log(`⚠️ Error moving ${file}: ${error.message}`);
      }
    }

    console.log(`\n📁 Moved ${movedCount} processed files to ${processedDir}`);
  }

  console.log('\n=== REPEATING TASKS MIGRATION COMPLETE ===');
  console.log(`✅ Successfully processed: ${processedCount} tasks`);
  console.log(`📋 Written to: ${outputFile}`);
  console.log(`⚠️ Errors: ${errorCount} tasks`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});