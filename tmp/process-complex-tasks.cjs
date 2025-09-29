#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function processComplexTask(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // Skip if already processed (has task checkbox)
    if (content.includes('- [ ]') || content.includes('- [x]')) {
      console.log(`  ⏭️ Already processed: ${path.basename(filePath)}`);
      return false;
    }

    // Parse frontmatter and content
    const parts = content.split('---\n');
    if (parts.length < 3) {
      console.log(`  ⚠️ Invalid frontmatter: ${path.basename(filePath)}`);
      return false;
    }

    const frontmatter = parts[1];
    const bodyContent = parts.slice(2).join('---\n');

    // Extract key fields from frontmatter
    const notionId = frontmatter.match(/notion_id:\s*"([^"]+)"/)?.[1];
    const title = frontmatter.match(/notion_title:\s*"([^"]+)"/)?.[1] || '';
    const isDone = frontmatter.includes('notion_done: true');
    const createdTime = frontmatter.match(/created_time:\s*"([^"]+)"/)?.[1];
    const completedDate = frontmatter.match(/notion_completed_date:\s*"([^"]+)"/)?.[1];

    if (!notionId || !title) {
      console.log(`  ⚠️ Missing required fields: ${path.basename(filePath)}`);
      return false;
    }

    // Format task line
    const checkbox = isDone ? '- [x]' : '- [ ]';
    let taskLine = `${checkbox} ${title}`;

    // Add created date
    if (createdTime) {
      const created = new Date(createdTime);
      const createdStr = created.toISOString().split('T')[0];
      taskLine += ` ➕ ${createdStr}`;
    }

    // Add completed date if done
    if (isDone && completedDate) {
      const completed = new Date(completedDate);
      const completedStr = completed.toISOString().split('T')[0];
      taskLine += ` ✅ ${completedStr}`;
    }

    // Add notion ID as comment
    taskLine += ` <!-- ${notionId} -->`;

    // Build new content with task line after frontmatter
    const newContent = `---\n${frontmatter}---\n\n${taskLine}\n\n${bodyContent}`;

    // Write the updated content
    fs.writeFileSync(filePath, newContent);

    console.log(`  ✓ Processed: ${path.basename(filePath)}`);
    return true;
  } catch (error) {
    console.error(`  ✗ Error processing ${path.basename(filePath)}: ${error.message}`);
    return false;
  }
}

async function main() {
  const tasksDir = 'vault/notion-migration/tasks';
  const complexDir = 'vault/tasks/complex';

  // Get all enriched task files
  const files = fs.readdirSync(tasksDir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(tasksDir, f));

  // Filter to only enriched files
  const enrichedFiles = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('migration_status: enriched')) {
        enrichedFiles.push(file);
      }
    } catch (error) {
      console.log(`⚠️ Error reading ${file}: ${error.message}`);
    }
  }

  console.log(`Found ${enrichedFiles.length} enriched task files\n`);

  let processedCount = 0;
  let movedCount = 0;

  for (const file of enrichedFiles) {
    console.log(`Processing ${path.basename(file)}...`);

    const processed = processComplexTask(file);
    if (processed) {
      processedCount++;

      // Move to complex directory
      const destPath = path.join(complexDir, path.basename(file));
      fs.renameSync(file, destPath);
      movedCount++;
      console.log(`  📁 Moved to: ${destPath}`);
    }

    console.log('');
  }

  console.log('=== PROCESSING COMPLETE ===');
  console.log(`✅ Processed: ${processedCount} files`);
  console.log(`📁 Moved to complex: ${movedCount} files`);
  console.log(`⚠️ Skipped: ${enrichedFiles.length - processedCount} files`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});