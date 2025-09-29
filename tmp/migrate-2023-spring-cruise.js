#!/usr/bin/env node

import { Client } from '@notionhq/client';
import fs from 'fs/promises';
import path from 'path';

// Task IDs for the 2023 Spring Transatlantic Cruise
const taskIds = [
  "46a9cbfe-d68f-4a1f-80fc-4b8c07b63922",
  "bf319cba-eb59-4456-9708-4d132fa671b7",
  "384fbb72-a39e-4eaf-93b4-08c1c0fb3365",
  "c97682ef-5b88-4d93-9eef-c9d080e543a5",
  "d0dafaa9-1f95-442f-ba64-6a43c09005e2",
  "d5c272c3-b88c-46f7-9127-1e957527a21d",
  "a9e8bd15-cbc6-4431-9102-7a366a4de6f1",
  "61f0e433-a498-4930-9f4c-7bf98f379876",
  "d8ccfe17-125a-4bb6-ba9a-fc97497bc581",
  "19932c20-22b0-4d33-a6eb-1f6f89034e89",
  "6e261aaf-74a9-4c4d-ac9b-e48d47e381a0",
  "7fc57fef-a357-4b59-9e05-ff81e272f85c",
  "325b760e-202a-4ac0-b406-8d1c29f8b21a",
  "d360ec6c-a2b6-4ad8-92f4-ffd777de4906",
  "c1425013-faba-4fe7-8445-03a65d1af6d5",
  "ce460d70-7151-45cf-bdc6-169856ab4850",
  "ad48cee0-97b5-4d97-b249-f0af9973d205",
  "7bd03089-d47a-436c-81d4-ad7ad352983a",
  "38ebd910-58fb-460f-9aa1-17f476d7dee2",
  "01ec3b76-5ce2-42d3-99d6-070c5d1d6e79",
  "8c8c72a3-6131-4307-968e-502683a7ce31",
  "3947b1cc-9fb3-439b-96f6-dacbd764c30c",
  "671bd1d9-0d72-484a-9146-9d9de9102104"
];

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function findTaskFile(taskId) {
  // Search for file with this notion_id
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
    console.error('Error searching for task:', error);
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
      // Add support for other block types as needed
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
      } else if (value.type === 'date' && value.date) {
        properties.date = value.date.start;
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

  // Save enriched file
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
  const projectFile = 'vault/projects/2023-spring-transatlantic-cruise.md';

  console.log('Processing 23 tasks for 2023 Spring Transatlantic Cruise...\n');

  // First, find all task files
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
    tasksSection += '### Tasks\n\n';
    for (const task of simpleTasks) {
      tasksSection += task.taskLine + '\n';
    }
    tasksSection += '\n';
  }

  // Add tasks with content
  const contentTasks = formattedTasks.filter(t => t.hasContent);
  if (contentTasks.length > 0) {
    tasksSection += '### Tasks with Details\n\n';
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

  // Append to project file
  const projectContent = await fs.readFile(projectFile, 'utf-8');
  const updatedContent = projectContent + tasksSection;
  await fs.writeFile(projectFile, updatedContent);

  console.log(`\n✓ Added ${formattedTasks.length} tasks to project file`);

  // Delete individual task files
  console.log('\nDeleting individual task files...');
  let deleteCount = 0;

  for (const task of formattedTasks) {
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
  console.log('\n✅ Migration complete for 2023 Spring Transatlantic Cruise!');

  // Summary
  console.log('\nSummary:');
  console.log(`- Total tasks processed: ${enrichedTasks.length}`);
  console.log(`- Tasks with content: ${tasksWithContent.length}`);
  console.log(`- Simple tasks: ${tasksWithoutContent.length}`);
  console.log(`- Files deleted: ${deleteCount}`);
}

main().catch(console.error);