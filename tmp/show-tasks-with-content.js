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

    // Extract just the content part from body
    let contentText = '';
    if (body.includes('## Content')) {
      const contentStart = body.indexOf('## Content') + '## Content'.length;
      contentText = body.substring(contentStart).trim();
      // Remove any "No additional content" markers
      contentText = contentText.replace('*No additional content*', '').trim();
    }

    return {
      taskLine,
      content: contentText,
      title,
      isDone
    };

  } catch (error) {
    console.error(`Error reading ${taskInfo.file}:`, error.message);
    return null;
  }
}

async function main() {
  console.log('Showing how tasks with content would look in the project file:\n');
  console.log('```markdown');
  console.log('## Tasks with Details\n');

  const tasks = [];

  // Process all tasks
  for (const taskInfo of tasksWithContent) {
    const task = await extractTaskWithContent(taskInfo);
    if (task) {
      tasks.push(task);
    }
  }

  // Show each task with its content
  for (const task of tasks) {
    console.log(task.taskLine);

    if (task.content) {
      // Indent the content to show it's related to the task
      const lines = task.content.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.log('  ' + line);
        }
      }
      console.log(''); // Empty line between tasks
    }
  }

  console.log('```');

  console.log('\n## Alternative format with collapsible details:\n');
  console.log('```markdown');
  console.log('## Tasks with Details\n');

  // Alternative with details/summary tags for collapsible content
  for (const task of tasks) {
    console.log(task.taskLine);

    if (task.content && task.content.length > 50) {
      console.log('<details>');
      console.log('<summary>View details</summary>\n');

      const lines = task.content.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.log(line);
        }
      }

      console.log('\n</details>\n');
    } else if (task.content) {
      // For short content, just indent it
      const lines = task.content.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.log('  ' + line);
        }
      }
      console.log('');
    }
  }

  console.log('```');

  // Show a summary
  console.log('\n## Summary of content lengths:\n');
  for (const task of tasks) {
    if (task.content) {
      console.log(`- ${task.title}: ${task.content.length} characters`);
    }
  }
}

main().catch(console.error);