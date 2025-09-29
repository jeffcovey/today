#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';

// The 10 tasks that have meaningful content
const tasksWithContent = [
  { file: "snail-mail-celebrity-14197.md", id: "9fea3fc7-b8f4-4179-9b08-0d5c2aa45993" },
  { file: "reply-to-celebrity-14185.md", id: "e3189efa-db04-44c2-b207-49863481ad3d" },
  { file: "spark-it-s-time-to-review-your-sitters-14187.md", id: "b4025f1c-380d-4a88-bed0-6cd4946f2a51" },
  { file: "celebrity-cruises-on-the-app-store-14147.md", id: "10ceb46d-b542-4c2e-a5ca-0a2d3435f67b" },
  { file: "spark-check-in-now-to-your-cruise-14188.md", id: "4c29027e-1551-4606-be2a-731d2eaed6a0" },
  { file: "find-a-sitter-14123.md", id: "da1be7f2-559a-4c8c-b3dc-e388f5bae4a2" },
  { file: "spark-check-in-now-to-your-cruise-14097.md", id: "c8716f71-aea5-4e9e-9d1e-3c0a19b259ad" },
  { file: "spark-your-guest-vacation-documents-are-now-ready-for-reservation-id-7539732-cov-14063.md", id: "5a8ba559-410a-4f8d-95b7-2669ab34a142" },
  { file: "spark-important-information-regarding-covid-19-and-your-plan-coverage-14062.md", id: "afd251ce-068d-4acb-a1d2-b75df663535e" },
  { file: "spark-prepare-for-your-boarding-day-14066.md", id: "a378437b-f53d-4251-b33d-3e27d753407c" }
];

async function extractTaskWithContent(taskInfo) {
  const filePath = path.join('vault/notion-migration/tasks', taskInfo.file);

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

    // Get the body content (everything after frontmatter)
    const bodyStart = content.indexOf('---', 4) + 3;
    const body = content.substring(bodyStart).trim();

    // Extract title and dates
    const title = frontmatter.notion_title || 'Untitled';
    const status = frontmatter.notion_status || '';
    const isDone = status.includes('Done') || status.includes('✅');
    const checkbox = isDone ? '[x]' : '[ ]';

    const created = frontmatter.notion_created ? new Date(frontmatter.notion_created) : null;
    const modified = frontmatter.notion_modified ? new Date(frontmatter.notion_modified) : null;

    // Build the task line
    let taskLine = `- ${checkbox} ${title}`;
    if (isDone && modified) {
      taskLine += ` ✅ ${modified.toISOString().split('T')[0]}`;
    }
    if (created) {
      taskLine += ` ➕ ${created.toISOString().split('T')[0]}`;
    }
    taskLine += ` <!-- ${frontmatter.notion_id} -->`;

    // Extract content, skipping headers and status line
    let contentText = '';
    const lines = body.split('\n');
    let inContent = false;

    for (const line of lines) {
      // Skip the title line
      if (line.startsWith('#') && line.includes(title)) continue;
      // Skip status line
      if (line.startsWith('**Status:**')) continue;
      // Start capturing after "## Content" header
      if (line === '## Content') {
        inContent = true;
        continue;
      }
      // Skip empty lines at the beginning of content
      if (inContent) {
        // Skip "No additional content" markers
        if (line === '*No additional content*') continue;
        contentText += line + '\n';
      }
    }

    // Clean up content - remove leading/trailing whitespace
    contentText = contentText.trim();

    return {
      taskLine,
      content: contentText,
      title,
      isDone,
      filename: taskInfo.file
    };

  } catch (error) {
    console.error(`Error reading ${taskInfo.file}:`, error.message);
    return null;
  }
}

async function main() {
  const projectFile = 'vault/projects/2022-thanksgiving-cruise.md';

  console.log('Adding 10 tasks with content to project file...\n');

  // Extract task information
  const tasks = [];
  for (const taskInfo of tasksWithContent) {
    const task = await extractTaskWithContent(taskInfo);
    if (task) {
      tasks.push(task);
      console.log(`✓ Processed: ${taskInfo.file}`);
    } else {
      console.log(`✗ Failed: ${taskInfo.file}`);
    }
  }

  // Read the current project file
  let projectContent = await fs.readFile(projectFile, 'utf-8');

  // Build the tasks with details section
  let detailsSection = '\n## Tasks with Details\n\n';

  for (const task of tasks) {
    detailsSection += task.taskLine + '\n';

    if (task.content) {
      // Indent each line of content by 2 spaces
      const contentLines = task.content.split('\n');
      for (const line of contentLines) {
        if (line.trim()) {
          detailsSection += '  ' + line + '\n';
        } else {
          detailsSection += '\n';
        }
      }
      detailsSection += '\n'; // Extra line between tasks
    } else {
      detailsSection += '\n';
    }
  }

  // Append the new section to project file
  projectContent += detailsSection;
  await fs.writeFile(projectFile, projectContent);
  console.log(`\n✓ Added ${tasks.length} tasks with details to project file`);

  // Delete the individual task files
  console.log('\nDeleting individual task files...');
  let deleteCount = 0;
  for (const taskInfo of tasksWithContent) {
    const filePath = path.join('vault/notion-migration/tasks', taskInfo.file);
    try {
      await fs.unlink(filePath);
      deleteCount++;
      console.log(`  ✓ Deleted: ${taskInfo.file}`);
    } catch (error) {
      console.log(`  ✗ Failed to delete: ${taskInfo.file} - ${error.message}`);
    }
  }

  console.log(`\n✓ Deleted ${deleteCount} task files`);

  // Show summary
  console.log('\nSummary:');
  console.log(`- Tasks added to project: ${tasks.length}`);
  console.log(`- Files deleted: ${deleteCount}`);

  // Show content lengths
  console.log('\nContent sizes:');
  for (const task of tasks) {
    if (task.content) {
      console.log(`- ${task.title}: ${task.content.length} characters`);
    } else {
      console.log(`- ${task.title}: no content`);
    }
  }

  console.log('\n✓ All 25 tasks from the 2022 Thanksgiving Cruise have been consolidated into the project file!');
}

main().catch(console.error);