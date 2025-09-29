#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function extractTitle(content) {
  // Try multiple patterns to extract title
  const patterns = [
    /notion_title:\s*"([^"]+)"/,
    /^#\s+(.+)$/m,
    /title:\s*"([^"]+)"/
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // Fallback to filename
  return null;
}

function categorizeTitle(title) {
  if (!title) return 'uncategorized';

  const lowerTitle = title.toLowerCase();

  // Email-related
  if (lowerTitle.includes('✉️') || lowerTitle.includes('email') || lowerTitle.includes('newsletter')) {
    return 'emails';
  }

  // Meetings/Notes
  if (lowerTitle.includes('meeting') || lowerTitle.includes('call') || lowerTitle.includes('notes')) {
    return 'meetings';
  }

  // Code/Development
  if (lowerTitle.includes('fix') || lowerTitle.includes('add') || lowerTitle.includes('update') ||
      lowerTitle.includes('remove') || lowerTitle.includes('test') || lowerTitle.includes('debug')) {
    return 'development';
  }

  // Personal tasks
  if (lowerTitle.includes('buy') || lowerTitle.includes('shop') || lowerTitle.includes('order') ||
      lowerTitle.includes('doctor') || lowerTitle.includes('appointment')) {
    return 'personal';
  }

  // Research/Reading
  if (lowerTitle.includes('read') || lowerTitle.includes('research') || lowerTitle.includes('learn')) {
    return 'research';
  }

  // Planning
  if (lowerTitle.includes('plan') || lowerTitle.includes('schedule') || lowerTitle.includes('organize')) {
    return 'planning';
  }

  // Financial
  if (lowerTitle.includes('pay') || lowerTitle.includes('invoice') || lowerTitle.includes('tax') ||
      lowerTitle.includes('$') || lowerTitle.includes('budget')) {
    return 'financial';
  }

  return 'other';
}

async function main() {
  const doneDir = 'vault/notion-migration/tasks/done';

  if (!fs.existsSync(doneDir)) {
    console.log('Done directory not found');
    return;
  }

  const files = fs.readdirSync(doneDir).filter(f => f.endsWith('.md'));
  console.log(`Found ${files.length} completed tasks\n`);

  const categories = {};
  const sampleTitles = [];
  let noTitle = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(doneDir, file), 'utf8');
    const title = extractTitle(content);

    if (!title) {
      noTitle++;
      continue;
    }

    const category = categorizeTitle(title);
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(title);

    // Collect sample titles
    if (sampleTitles.length < 20) {
      sampleTitles.push(title);
    }
  }

  console.log('=== TASK CATEGORIES ===\n');
  for (const [category, titles] of Object.entries(categories)) {
    console.log(`${category.toUpperCase()} (${titles.length} tasks)`);
    // Show first 3 examples
    titles.slice(0, 3).forEach(t => console.log(`  - ${t.substring(0, 80)}${t.length > 80 ? '...' : ''}`));
    console.log();
  }

  console.log(`\n=== STATISTICS ===`);
  console.log(`Total completed tasks: ${files.length}`);
  console.log(`Tasks without titles: ${noTitle}`);
  console.log(`Tasks with titles: ${files.length - noTitle}`);

  console.log('\n=== SAMPLE TITLES (First 20) ===');
  sampleTitles.forEach(title => {
    console.log(`- ${title}`);
  });
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});