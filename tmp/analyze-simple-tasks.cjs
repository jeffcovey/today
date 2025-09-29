#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function analyzeTaskFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Parse frontmatter and content
  const parts = content.split('---\n');
  if (parts.length < 3) return null;

  const frontmatter = parts[1];
  const bodyContent = parts.slice(2).join('---\n').trim();

  // Extract key fields from frontmatter
  const notionId = frontmatter.match(/notion_id:\s*"([^"]+)"/)?.[1];
  const title = frontmatter.match(/notion_title:\s*"([^"]+)"/)?.[1] || '';
  const isDone = frontmatter.includes('notion_done: true');
  const status = frontmatter.match(/notion_status:\s*"([^"]+)"/)?.[1];
  const createdDate = frontmatter.match(/created_time:\s*"([^"]+)"/)?.[1];
  const completedDate = frontmatter.match(/notion_completed_date:\s*"([^"]+)"/)?.[1];

  // Check if body has actual content beyond title and status
  let hasExtraContent = false;
  const lines = bodyContent.split('\n').filter(line => line.trim());

  // Skip the title line (# Title)
  const contentLines = lines.filter(line => {
    if (line.startsWith('#') && line.includes(title)) return false;
    if (line.startsWith('**Status:**')) return false;
    return line.trim().length > 0;
  });

  hasExtraContent = contentLines.length > 0;

  return {
    file: path.basename(filePath),
    title: title,
    isDone: isDone,
    status: status,
    createdDate: createdDate,
    completedDate: completedDate,
    hasExtraContent: hasExtraContent,
    contentLineCount: contentLines.length,
    notionId: notionId
  };
}

function formatAsObsidianTask(task) {
  // Format as Obsidian Task Plugin syntax
  const checkbox = task.isDone ? '- [x]' : '- [ ]';
  let taskLine = `${checkbox} ${task.title}`;

  // Add dates using emoji format
  if (task.createdDate) {
    const created = new Date(task.createdDate);
    const createdStr = created.toISOString().split('T')[0];
    taskLine += ` ➕ ${createdStr}`;
  }

  if (task.completedDate) {
    const completed = new Date(task.completedDate);
    const completedStr = completed.toISOString().split('T')[0];
    taskLine += ` ✅ ${completedStr}`;
  }

  // Add notion ID as comment for traceability
  taskLine += ` <!-- ${task.notionId} -->`;

  return taskLine;
}

async function main() {
  const tasksDir = 'vault/notion-migration/tasks';

  // Get all enriched task files
  const files = fs.readdirSync(tasksDir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(tasksDir, f));

  // Read and check migration_status for enriched files
  const enrichedFiles = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('migration_status: enriched')) {
      enrichedFiles.push(file);
    }
  }

  console.log(`Found ${enrichedFiles.length} enriched task files\n`);

  const simpleTasks = [];
  const complexTasks = [];

  for (const file of enrichedFiles) {
    const analysis = analyzeTaskFile(file);
    if (!analysis) continue;

    if (analysis.hasExtraContent) {
      complexTasks.push(analysis);
    } else {
      simpleTasks.push(analysis);
    }
  }

  console.log('=== TASK COMPLEXITY ANALYSIS ===\n');
  console.log(`Simple tasks (single-line compatible): ${simpleTasks.length}`);
  console.log(`Complex tasks (need full files): ${complexTasks.length}`);
  console.log(`Total enriched: ${enrichedFiles.length}\n`);

  // Show percentage
  const simplePercent = ((simpleTasks.length / enrichedFiles.length) * 100).toFixed(1);
  console.log(`${simplePercent}% of enriched tasks can be converted to single-line format\n`);

  // Show examples of simple tasks as Obsidian format
  console.log('=== EXAMPLE SIMPLE TASKS (Obsidian Format) ===\n');
  simpleTasks.slice(0, 10).forEach(task => {
    console.log(formatAsObsidianTask(task));
  });

  // Show examples of complex tasks
  console.log('\n=== EXAMPLE COMPLEX TASKS (Need Full Files) ===\n');
  complexTasks.slice(0, 5).forEach(task => {
    console.log(`${task.file}:`);
    console.log(`  Title: ${task.title}`);
    console.log(`  Extra content lines: ${task.contentLineCount}`);
    console.log();
  });

  // Group simple tasks by status
  const statusGroups = {};
  simpleTasks.forEach(task => {
    const status = task.status || 'No Status';
    if (!statusGroups[status]) {
      statusGroups[status] = [];
    }
    statusGroups[status].push(task);
  });

  console.log('=== SIMPLE TASKS BY STATUS ===\n');
  for (const [status, tasks] of Object.entries(statusGroups)) {
    console.log(`${status}: ${tasks.length} tasks`);
  }
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});