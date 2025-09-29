#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';

// Task IDs that have no meaningful content (from the enrichment output)
const noContentTaskFiles = [
  "ask-for-the-balcony-upgrade-14286.md",
  "see-if-our-cruise-conflicts-with-vincent-s-plans-14289.md",
  "find-sitters-for-buster-14290.md",
  "book-excursions-14291.md",
  "add-cruise-details-to-tripit-14284.md",
  "ask-sean-whether-he-can-meet-us-in-nassau-14247.md",
  "review-house-sitters-14204.md",
  "check-trusted-housesitters-14170.md",
  "find-a-sitter-14139.md",
  "split-the-room-income-with-debra-14104.md",
  "look-at-cruise-insurance-14125.md",
  "check-celebrity-internet-access-14074.md",
  "write-a-house-guide-for-debra-14092.md",
  "tell-debra-that-the-shipments-will-be-arriving-from-amazon-14070.md",
  "put-allianz-app-on-ron-s-phone-14079.md"
];

async function convertToTaskLine(filename) {
  const filePath = path.join('vault/notion-migration/tasks', filename);

  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // Parse frontmatter
    const frontmatterEnd = content.indexOf('---', 4);
    const frontmatterLines = content.substring(4, frontmatterEnd).split('\n');

    let frontmatter = {};
    for (const line of frontmatterLines) {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        frontmatter[match[1].trim()] = match[2].trim().replace(/"/g, '');
      }
    }

    // Extract key information
    const title = frontmatter.notion_title || 'Untitled';
    const status = frontmatter.notion_status || '';
    const isDone = status.includes('Done') || status.includes('✅');
    const checkbox = isDone ? '[x]' : '[ ]';

    // Format dates
    const created = frontmatter.notion_created ? new Date(frontmatter.notion_created) : null;
    const modified = frontmatter.notion_modified ? new Date(frontmatter.notion_modified) : null;

    // Build the task line
    let taskLine = `- ${checkbox} ${title}`;

    // Add completion date if done
    if (isDone && modified) {
      const dateStr = modified.toISOString().split('T')[0];
      taskLine += ` ✅ ${dateStr}`;
    }

    // Add created date for reference
    if (created) {
      const createdStr = created.toISOString().split('T')[0];
      taskLine += ` 📅 ${createdStr}`;
    }

    return {
      filename,
      taskLine,
      notionId: frontmatter.notion_id
    };

  } catch (error) {
    console.error(`Error processing ${filename}:`, error.message);
    return null;
  }
}

async function main() {
  console.log('Converting 14 no-content tasks to Obsidian Tasks format:\n');
  console.log('```markdown');
  console.log('## Tasks\n');

  const results = [];

  for (const filename of noContentTaskFiles) {
    const result = await convertToTaskLine(filename);
    if (result) {
      results.push(result);
      console.log(result.taskLine);
    }
  }

  console.log('```');

  console.log('\n## With notion_id references (for traceability):\n');
  console.log('```markdown');
  for (const result of results) {
    if (result) {
      console.log(`${result.taskLine} <!-- ${result.notionId} -->`);
    }
  }
  console.log('```');

  console.log('\n## Sorted by completion status:\n');
  console.log('```markdown');

  // Sort: incomplete first, then completed
  const sorted = results.sort((a, b) => {
    const aComplete = a.taskLine.includes('[x]');
    const bComplete = b.taskLine.includes('[x]');
    if (aComplete === bComplete) return 0;
    return aComplete ? 1 : -1;
  });

  console.log('### Open Tasks');
  for (const result of sorted) {
    if (result && !result.taskLine.includes('[x]')) {
      console.log(result.taskLine);
    }
  }

  console.log('\n### Completed Tasks');
  for (const result of sorted) {
    if (result && result.taskLine.includes('[x]')) {
      console.log(result.taskLine);
    }
  }

  console.log('```');
}

main().catch(console.error);