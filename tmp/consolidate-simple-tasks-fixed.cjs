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

  // Skip the title line (# Title) and status line
  const contentLines = lines.filter(line => {
    if (line.startsWith('#') && line.includes(title)) return false;
    if (line.startsWith('**Status:**')) return false;
    if (line.includes('*Placeholder - run enrichment to get full content*')) return false;
    return line.trim().length > 0;
  });

  hasExtraContent = contentLines.length > 0;

  return {
    file: path.basename(filePath),
    filePath: filePath,
    title: title,
    isDone: isDone,
    status: status,
    createdDate: createdDate,
    completedDate: completedDate,
    hasExtraContent: hasExtraContent,
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
  const processedDir = 'vault/notion-migration/tasks/processed';
  const outputFile = 'vault/tasks/tasks.md';

  // Create processed directory if it doesn't exist
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }

  // Create tasks directory if it doesn't exist
  const tasksOutputDir = path.dirname(outputFile);
  if (!fs.existsSync(tasksOutputDir)) {
    fs.mkdirSync(tasksOutputDir, { recursive: true });
  }

  // Get all enriched task files
  const files = fs.readdirSync(tasksDir)
    .filter(f => f.endsWith('.md') && f !== 'processed')
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
  let movedCount = 0;

  for (const file of enrichedFiles) {
    const analysis = analyzeTaskFile(file);
    if (!analysis) continue;

    if (analysis.hasExtraContent) {
      complexTasks.push(analysis);
    } else {
      simpleTasks.push(analysis);
    }
  }

  // Build content for tasks.md - JUST TASKS, NO HEADERS
  let tasksContent = '';

  for (const task of simpleTasks) {
    tasksContent += formatAsObsidianTask(task) + '\n';

    // Move the file to processed directory
    const destPath = path.join(processedDir, path.basename(task.filePath));
    fs.renameSync(task.filePath, destPath);
    movedCount++;
  }

  // Append to tasks.md
  fs.appendFileSync(outputFile, tasksContent);

  console.log('=== CONSOLIDATION COMPLETE ===\n');
  console.log(`✅ Consolidated ${simpleTasks.length} simple tasks to ${outputFile}`);
  console.log(`📁 Moved ${movedCount} files to ${processedDir}`);
  console.log(`⚠️ ${complexTasks.length} complex tasks remain in original location (need manual review)`);

  // List some of the complex tasks that need review
  if (complexTasks.length > 0) {
    console.log('\n=== COMPLEX TASKS (not moved) ===');
    complexTasks.slice(0, 10).forEach(task => {
      console.log(`- ${task.file}: ${task.title}`);
    });
    if (complexTasks.length > 10) {
      console.log(`... and ${complexTasks.length - 10} more`);
    }
  }
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});