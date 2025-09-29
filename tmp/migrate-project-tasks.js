#!/usr/bin/env node

import { Client } from '@notionhq/client';
import fs from 'fs/promises';
import path from 'path';

// Get project name from command line
const projectFileName = process.argv[2];
if (!projectFileName) {
  console.error('Usage: node migrate-project-tasks.js <project-file-name>');
  console.error('Example: node migrate-project-tasks.js 2024-england-housesit.md');
  process.exit(1);
}

const projectPath = path.join('vault/projects', projectFileName);
const notion = new Client({ auth: process.env.NOTION_TOKEN });

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

async function enrichTaskFromNotion(taskId, filename) {
  try {
    const page = await notion.pages.retrieve({ page_id: taskId });
    const blocks = await notion.blocks.children.list({ block_id: taskId });

    // Extract text content from blocks
    let content = '';
    for (const block of blocks.results) {
      if (block.type === 'paragraph' && block.paragraph?.rich_text) {
        const text = block.paragraph.rich_text.map(t => t.plain_text).join('');
        if (text.trim()) {
          content += text + '\n';
        }
      }
    }

    // Get properties
    const properties = {};
    for (const [key, value] of Object.entries(page.properties)) {
      if (value.type === 'title' && value.title?.[0]) {
        properties.title = value.title[0].plain_text;
      } else if (value.type === 'status' && value.status) {
        properties.status = value.status.name;
      } else if (value.type === 'checkbox') {
        properties.done = value.checkbox;
      } else if (value.type === 'created_time') {
        properties.created = value.created_time;
      } else if (value.type === 'last_edited_time') {
        properties.modified = value.last_edited_time;
      }
    }

    return {
      filename,
      id: taskId,
      title: properties.title || 'Untitled',
      status: properties.status || '',
      isDone: properties.done || properties.status?.includes('Done') || properties.status?.includes('✅'),
      created: properties.created,
      modified: properties.modified,
      content: content.trim(),
      url: page.url
    };
  } catch (error) {
    console.error(`Error enriching task ${taskId}:`, error.message);
    return null;
  }
}

async function enrichAndSaveTask(taskId, filename) {
  const enrichedData = await enrichTaskFromNotion(taskId, filename);
  if (!enrichedData) return null;

  // Read existing file to preserve frontmatter
  const filePath = path.join('vault/notion-migration/tasks', filename);
  const existingContent = await fs.readFile(filePath, 'utf-8');

  // Parse existing frontmatter
  const frontmatterEnd = existingContent.indexOf('---', 4);
  const frontmatterLines = existingContent.substring(4, frontmatterEnd).split('\n');

  let existingFrontmatter = {};
  for (const line of frontmatterLines) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      existingFrontmatter[match[1].trim()] = match[2].trim();
    }
  }

  // Merge with new data
  const mergedFrontmatter = { ...existingFrontmatter };
  mergedFrontmatter.migration_status = 'enriched';
  mergedFrontmatter.notion_title = `"${enrichedData.title}"`;
  mergedFrontmatter.notion_status = `"${enrichedData.status}"`;
  mergedFrontmatter.notion_done = enrichedData.isDone;
  mergedFrontmatter.notion_created = enrichedData.created;
  mergedFrontmatter.notion_modified = enrichedData.modified;
  if (!mergedFrontmatter.notion_url) {
    mergedFrontmatter.notion_url = `"${enrichedData.url}"`;
  }

  // Build new content
  let newContent = '---\n';
  for (const [key, value] of Object.entries(mergedFrontmatter)) {
    if (typeof value === 'string' && !value.startsWith('"') && !value.startsWith('[')) {
      newContent += `${key}: "${value}"\n`;
    } else {
      newContent += `${key}: ${value}\n`;
    }
  }
  newContent += '---\n';
  newContent += `# ${enrichedData.title}\n\n`;
  newContent += `**Status:** ${enrichedData.status}\n\n`;

  if (enrichedData.content) {
    newContent += '## Content\n\n';
    newContent += enrichedData.content;
  } else {
    newContent += '## Content\n\n*No additional content*\n';
  }

  await fs.writeFile(filePath, newContent);
  return enrichedData;
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
  return { taskLine, content: task.content };
}

async function main() {
  // Check if project file exists
  try {
    await fs.access(projectPath);
  } catch {
    console.error(`Project file not found: ${projectPath}`);
    process.exit(1);
  }

  console.log(`Processing tasks for ${projectFileName}...\n`);

  // Extract task IDs from project file
  const taskIds = await extractTaskIds(projectPath);
  console.log(`Found ${taskIds.length} task IDs in project file\n`);

  if (taskIds.length === 0) {
    console.log('No tasks to process');
    process.exit(0);
  }

  // Find all task files
  const taskMappings = [];
  for (const taskId of taskIds) {
    const filename = await findTaskFile(taskId);
    if (filename) {
      taskMappings.push({ id: taskId, filename });
      console.log(`✓ Found task file: ${filename}`);
    } else {
      console.log(`✗ Task not found: ${taskId}`);
    }
  }

  console.log(`\nFound ${taskMappings.length} of ${taskIds.length} task files`);

  // Enrich all tasks
  console.log('\nEnriching tasks from Notion API...');
  const enrichedTasks = [];

  for (const mapping of taskMappings) {
    const task = await enrichAndSaveTask(mapping.id, mapping.filename);
    if (task) {
      enrichedTasks.push(task);
      console.log(`✓ Enriched: ${task.title}`);
    } else {
      console.log(`✗ Failed to enrich: ${mapping.filename}`);
    }
  }

  console.log(`\n✓ Enriched ${enrichedTasks.length} tasks`);

  // Separate tasks with and without content
  const tasksWithContent = enrichedTasks.filter(t => t.content && t.content.length > 0);
  const tasksWithoutContent = enrichedTasks.filter(t => !t.content || t.content.length === 0);

  console.log(`\nTasks with content: ${tasksWithContent.length}`);
  console.log(`Tasks without content: ${tasksWithoutContent.length}`);

  // Format all tasks
  const formattedTasks = [];
  for (const task of enrichedTasks) {
    const formatted = await formatTaskLine(task);
    formattedTasks.push({
      ...formatted,
      filename: task.filename,
      hasContent: !!task.content
    });
  }

  // Sort: open first, then completed
  formattedTasks.sort((a, b) => {
    const aDone = a.taskLine.includes('[x]');
    const bDone = b.taskLine.includes('[x]');
    if (aDone === bDone) return 0;
    return aDone ? 1 : -1;
  });

  // Build tasks section
  let tasksSection = '\n## Tasks\n\n';

  // Add simple tasks
  const simpleTasks = formattedTasks.filter(t => !t.hasContent);
  if (simpleTasks.length > 0) {
    if (tasksWithContent.length > 0) {
      tasksSection += '### Tasks\n\n';
    }
    for (const task of simpleTasks) {
      tasksSection += task.taskLine + '\n';
    }
    if (tasksWithContent.length > 0) {
      tasksSection += '\n';
    }
  }

  // Add tasks with content
  const contentTasks = formattedTasks.filter(t => t.hasContent);
  if (contentTasks.length > 0) {
    if (simpleTasks.length > 0) {
      tasksSection += '### Tasks with Details\n\n';
    }
    for (const task of contentTasks) {
      tasksSection += task.taskLine + '\n';
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

  // DON'T CONSOLIDATE OR DELETE - JUST ENRICH IN PLACE
  console.log(`\n✅ Successfully enriched ${enrichedTasks.length} task files`);

  // Summary
  console.log('\nSummary:');
  console.log(`- Total tasks enriched: ${enrichedTasks.length}`);
  console.log(`- Tasks with content: ${tasksWithContent.length}`);
  console.log(`- Tasks without content: ${tasksWithoutContent.length}`);
  console.log('\nTask files remain in vault/notion-migration/tasks/ with enriched content');
}

main().catch(console.error);