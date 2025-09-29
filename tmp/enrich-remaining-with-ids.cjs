#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_ACTION_ITEMS_DB_ID;

async function enrichTaskFile(filePath) {
  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠️ File not found: ${filePath}`);
      return false;
    }

    const content = fs.readFileSync(filePath, 'utf8');

    // Skip if already enriched
    if (content.includes('migration_status: enriched')) {
      console.log(`  ⏭️ Already enriched: ${path.basename(filePath)}`);
      return false;
    }

    // Extract Notion ID from file content
    const notionIdMatch = content.match(/notion_id:\s*"?([a-f0-9-]{36})"?/);
    if (!notionIdMatch) {
      console.log(`  ⚠️ No Notion ID in content: ${path.basename(filePath)}`);
      return false;
    }

    const pageId = notionIdMatch[1];

    // Fetch fresh data from Notion
    const page = await notion.pages.retrieve({ page_id: pageId });

    // Extract properties with correct field names for Action Items database
    const titleArray = page.properties?.['Action Item']?.title || [];
    const title = titleArray.map(t => t.plain_text).join('');
    const status = page.properties?.['Status']?.status?.name || '';
    const isDone = status.includes('Done') || status.includes('✅');
    const createdTime = page.created_time;
    const lastEditedTime = page.last_edited_time;

    // Extract completed date if done
    let completedDate = null;
    if (isDone && page.properties?.['Completed Date']?.date?.start) {
      completedDate = page.properties['Completed Date'].date.start;
    } else if (isDone) {
      // Use last edited time as fallback for completed date
      completedDate = lastEditedTime.split('T')[0];
    }

    // Build enriched frontmatter
    const enrichedFrontmatter = [
      '---',
      `notion_id: "${pageId}"`,
      `notion_url: "${page.url}"`,
      `notion_title: "${title.replace(/"/g, '\\"')}"`,
      `notion_status: "${status}"`,
      `notion_done: ${isDone}`,
      completedDate ? `notion_completed_date: "${completedDate}"` : null,
      `created_time: "${createdTime}"`,
      `last_edited_time: "${lastEditedTime}"`,
      `migration_status: enriched`,
      '---'
    ].filter(line => line !== null).join('\n');

    // Parse existing content to preserve body
    const parts = content.split('---\n');
    const bodyContent = parts.length >= 3 ? parts.slice(2).join('---\n') : '';

    // Create enriched body with title and status
    let enrichedBody = `# ${title}\n\n`;
    if (status) {
      enrichedBody += `**Status:** ${status}\n\n`;
    }

    // Add any existing body content
    if (bodyContent.trim()) {
      const existingBodyWithoutOldTitle = bodyContent
        .replace(/^#.*\n/, '') // Remove any existing title
        .trim();
      if (existingBodyWithoutOldTitle) {
        enrichedBody += existingBodyWithoutOldTitle;
      }
    }

    // Write enriched content
    const enrichedContent = `${enrichedFrontmatter}\n\n${enrichedBody}`;
    fs.writeFileSync(filePath, enrichedContent);

    console.log(`  ✓ Enriched: ${path.basename(filePath)}`);
    return true;
  } catch (error) {
    console.error(`  ✗ Error enriching ${path.basename(filePath)}: ${error.message}`);
    return false;
  }
}

async function processInBatches(files, batchSize = 10) {
  let enrichedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    console.log(`\n📦 Processing batch ${Math.floor(i/batchSize) + 1} (files ${i+1}-${Math.min(i+batchSize, files.length)} of ${files.length})`);

    const promises = batch.map(file => enrichTaskFile(file));

    const results = await Promise.all(promises);
    enrichedCount += results.filter(r => r === true).length;
    errorCount += results.filter(r => r === false).length;

    // Small delay between batches to avoid rate limits
    if (i + batchSize < files.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return { enrichedCount, errorCount };
}

async function main() {
  const tasksDir = 'vault/notion-migration/tasks';

  // Get all task files that have notion_id but aren't enriched
  const files = fs.readdirSync(tasksDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .map(f => path.join(tasksDir, f));

  // Filter to files with notion_id but not enriched
  const filesToEnrich = [];
  for (const file of files) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('notion_id:') && !content.includes('migration_status: enriched')) {
        filesToEnrich.push(file);
      }
    }
  }

  console.log(`Found ${filesToEnrich.length} files with Notion IDs that need enrichment`);

  if (filesToEnrich.length === 0) {
    console.log('✅ All files with Notion IDs are already enriched!');
    return;
  }

  // Process files
  const { enrichedCount, errorCount } = await processInBatches(filesToEnrich);

  console.log('\n=== ENRICHMENT COMPLETE ===');
  console.log(`✅ Successfully enriched: ${enrichedCount} files`);
  console.log(`⚠️ Errors: ${errorCount} files`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});