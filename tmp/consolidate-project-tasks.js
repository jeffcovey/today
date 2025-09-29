#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';

// Get project name from command line
const projectFileName = process.argv[2];
if (!projectFileName) {
  console.error('Usage: node consolidate-project-tasks.js <project-file-name>');
  console.error('Example: node consolidate-project-tasks.js 2023-fall-transatlantic-cruise.md');
  process.exit(1);
}

const projectPath = path.join('vault/projects', projectFileName);

async function extractTaskIds(projectFile) {
  const content = await fs.readFile(projectFile, 'utf-8');
  const match = content.match(/notion_action_items_tasks:\s*\[(.*?)\]/);
  if (!match) return [];

  // Extract IDs from the array string
  const idsString = match[1];
  const ids = idsString.match(/"([^"]+)"/g);
  if (!ids) return [];

  return ids.map(id => id.replace(/"/g, ''));
}

async function findTaskFile(taskId) {
  try {
    const files = await fs.readdir('vault/notion-migration/tasks');
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const content = await fs.readFile(path.join('vault/notion-migration/tasks', file), 'utf-8');
      if (content.includes(`notion_id: "${taskId}"`)) {
        return file;
      }
    }
  } catch (error) {
    console.error('Error searching for task:', error.message);
  }
  return null;
}

async function readEnrichedTask(filename) {
  const filePath = path.join('vault/notion-migration/tasks', filename);
  const content = await fs.readFile(filePath, 'utf-8');

  // Parse frontmatter
  const frontmatterEnd = content.indexOf('---', 4);
  const frontmatterLines = content.substring(4, frontmatterEnd).split('\n');

  let frontmatter = {};
  for (const line of frontmatterLines) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^"(.*)"$/, '$1');
      frontmatter[key] = value;
    }
  }

  // Extract content after frontmatter
  const bodyStart = content.indexOf('---', 4) + 3;
  const body = content.substring(bodyStart).trim();

  // Extract actual content (after "## Content" header)
  let taskContent = '';
  if (body.includes('## Content')) {
    const contentStart = body.indexOf('## Content') + '## Content'.length;
    taskContent = body.substring(contentStart).trim();
    // Remove "No additional content" markers
    if (taskContent === '*No additional content*') {
      taskContent = '';
    }
  }

  return {
    filename,
    id: frontmatter.notion_id,
    title: frontmatter.notion_title || 'Untitled',
    status: frontmatter.notion_status || '',
    isDone: frontmatter.notion_done === 'true' || frontmatter.notion_done === true,
    created: frontmatter.notion_created,
    modified: frontmatter.notion_modified,
    content: taskContent
  };
}

async function formatTaskLine(task) {
  const checkbox = task.isDone ? '[x]' : '[ ]';
  let taskLine = `- ${checkbox} ${task.title}`;

  if (task.isDone && task.modified) {
    const date = new Date(task.modified).toISOString().split('T')[0];
    taskLine += ` ✅ ${date}`;
  }

  if (task.created) {
    const date = new Date(task.created).toISOString().split('T')[0];
    taskLine += ` ➕ ${date}`;
  }

  taskLine += ` <!-- ${task.id} -->`;
  return taskLine;
}

async function main() {
  // Check if project file exists
  try {
    await fs.access(projectPath);
  } catch {
    console.error(`Project file not found: ${projectPath}`);
    process.exit(1);
  }

  console.log(`Consolidating tasks for ${projectFileName}...\n`);

  // Extract task IDs from project file
  const taskIds = await extractTaskIds(projectPath);
  console.log(`Found ${taskIds.length} task IDs in project file\n`);

  if (taskIds.length === 0) {
    console.log('No tasks to consolidate');
    process.exit(0);
  }

  // Find and read all task files
  const tasks = [];
  for (const taskId of taskIds) {
    const filename = await findTaskFile(taskId);
    if (filename) {
      const task = await readEnrichedTask(filename);
      tasks.push(task);
      console.log(`✓ Read task: ${task.title}`);
    } else {
      console.log(`✗ Task file not found: ${taskId}`);
    }
  }

  console.log(`\nFound ${tasks.length} of ${taskIds.length} task files`);

  // Separate tasks with and without content
  const tasksWithContent = tasks.filter(t => t.content && t.content.length > 0);
  const tasksWithoutContent = tasks.filter(t => !t.content || t.content.length === 0);

  console.log(`Tasks with content: ${tasksWithContent.length}`);
  console.log(`Tasks without content: ${tasksWithoutContent.length}`);

  // Sort tasks: open first, then completed
  tasks.sort((a, b) => {
    if (a.isDone === b.isDone) return 0;
    return a.isDone ? 1 : -1;
  });

  // Build tasks section
  let tasksSection = '\n## Tasks\n\n';

  // Add simple tasks (without content)
  if (tasksWithoutContent.length > 0) {
    if (tasksWithContent.length > 0) {
      tasksSection += '### Tasks\n\n';
    }
    for (const task of tasksWithoutContent) {
      const taskLine = await formatTaskLine(task);
      tasksSection += taskLine + '\n';
    }
    if (tasksWithContent.length > 0) {
      tasksSection += '\n';
    }
  }

  // Add tasks with content
  if (tasksWithContent.length > 0) {
    if (tasksWithoutContent.length > 0) {
      tasksSection += '### Tasks with Details\n\n';
    }
    for (const task of tasksWithContent) {
      const taskLine = await formatTaskLine(task);
      tasksSection += taskLine + '\n';

      // Add indented content
      if (task.content) {
        const lines = task.content.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            tasksSection += '  ' + line + '\n';
          }
        }
        tasksSection += '\n';
      }
    }
  }

  // Append to project file
  const projectContent = await fs.readFile(projectPath, 'utf-8');
  const updatedContent = projectContent + tasksSection;
  await fs.writeFile(projectPath, updatedContent);

  console.log(`\n✓ Added ${tasks.length} tasks to project file`);

  // Delete individual task files
  console.log('\nDeleting individual task files...');
  let deleteCount = 0;

  for (const task of tasks) {
    const filePath = path.join('vault/notion-migration/tasks', task.filename);
    try {
      await fs.unlink(filePath);
      deleteCount++;
      console.log(`  ✓ Deleted: ${task.filename}`);
    } catch (error) {
      console.log(`  ✗ Failed to delete: ${task.filename}`);
    }
  }

  console.log(`\n✓ Deleted ${deleteCount} task files`);
  console.log(`\n✅ Consolidation complete for ${projectFileName}!`);

  // Summary
  console.log('\nSummary:');
  console.log(`- Total tasks consolidated: ${tasks.length}`);
  console.log(`- Tasks with content: ${tasksWithContent.length}`);
  console.log(`- Simple tasks: ${tasksWithoutContent.length}`);
  console.log(`- Files deleted: ${deleteCount}`);
}

main().catch(console.error);