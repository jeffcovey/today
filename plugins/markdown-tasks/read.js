#!/usr/bin/env node

// Sync tasks from markdown files (Obsidian Tasks format)
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries and metadata
//
// Uses vault-changes for efficient incremental sync - only processes
// files that have actually changed instead of grepping entire vault.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getChangedFilePaths, getBaselineStatus } from '../../src/vault-changes.js';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const lastSyncTime = process.env.LAST_SYNC_TIME || '';
const fileFilter = process.env.FILE_FILTER || '';  // Sync only specific file(s)

const directory = config.directory || process.env.VAULT_PATH;
const excludePaths = (config.exclude_paths || 'templates,.obsidian')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);
const includeCompleted = config.include_completed !== false;

const rootDir = path.join(projectRoot, directory);

// Check if directory exists
if (!fs.existsSync(rootDir)) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      message: `Tasks directory not found: ${directory}`,
      hint: 'Create the directory and add .md files with Obsidian-style tasks'
    }
  }));
  process.exit(0);
}

// Parse last sync time
const lastSyncDate = lastSyncTime ? new Date(lastSyncTime) : null;

// Parse file filter (comma-separated list of relative paths)
const filterFiles = fileFilter
  ? fileFilter.split(',').map(f => path.join(projectRoot, f.trim()))
  : null;

// Find markdown files with tasks
let filesWithTasks;
let isIncremental = false;

// If file filter is specified, only process those files
if (filterFiles) {
  filesWithTasks = filterFiles.filter(f => fs.existsSync(f));
  isIncremental = true;
} else if (lastSyncDate) {
  // Use vault-changes for efficient incremental sync
  const baselineStatus = getBaselineStatus();
  if (baselineStatus.exists) {
    // Get files changed today from vault-changes
    const changedFiles = getChangedFilePaths({
      directory: rootDir,
      todayOnly: true,
      includeGit: false
    });
    // Filter to only include files that might have tasks
    filesWithTasks = changedFiles.filter(f => {
      // Skip excluded paths
      const relativePath = path.relative(rootDir, f);
      return !excludePaths.some(exc => relativePath.startsWith(exc));
    });
    isIncremental = true;
  } else {
    // No baseline yet - fall back to grep for first run
    filesWithTasks = findAllTaskFiles();
    isIncremental = true;
  }
} else {
  // Full sync - find all files with tasks using grep -r
  filesWithTasks = findAllTaskFiles();
}

// Helper function to find all task files via grep
function findAllTaskFiles() {
  try {
    // Build exclude args for grep
    const excludeArgs = excludePaths
      .map(p => `--exclude-dir="${p}"`)
      .join(' ');

    // Find files containing task checkboxes using grep -r
    const cmd = `grep -rl ${excludeArgs} --include="*.md" "^- \\[[x ]\\]" "${rootDir}" 2>/dev/null || true`;
    return execSync(cmd, { encoding: 'utf8' })
      .split('\n')
      .filter(f => f.trim());
  } catch (error) {
    console.error(JSON.stringify({ error: `Cannot find task files: ${error.message}` }));
    process.exit(1);
  }
}

// Files to sync are those we found
let filesToSync = filesWithTasks;

// Parse entries from files that need syncing
const entries = [];
const filesProcessed = [];

// Priority emoji to normalized value mapping
const priorityMap = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest'
};

// Task line regex: - [ ] or - [x] at start
const taskRegex = /^- \[([x ])\] (.+)$/;

for (const filePath of filesToSync) {
  const relativePath = path.relative(projectRoot, filePath);
  filesProcessed.push(relativePath);

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    continue;
  }

  const lines = content.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const match = line.match(taskRegex);
    if (!match) continue;

    const isCompleted = match[1] === 'x';
    if (!includeCompleted && isCompleted) continue;

    const taskContent = match[2];

    // Parse the task
    const task = parseTask(taskContent, isCompleted);

    entries.push({
      id: `${relativePath}:${lineNum + 1}`,
      title: task.title,
      status: isCompleted ? 'completed' : 'open',
      priority: task.priority,
      due_date: task.dueDate,
      completed_at: task.completedAt,
      description: null, // Markdown tasks typically don't have separate description
      metadata: JSON.stringify({
        file_path: relativePath,
        line_number: lineNum + 1,
        stage: task.stage,
        topics: task.topics,
        scheduled_date: task.scheduledDate,
        created_date: task.createdDate,
        recurrence: task.recurrence,
        raw_line: line
      })
    });
  }
}

// Output JSON
console.log(JSON.stringify({
  entries,
  files_processed: filesProcessed,
  incremental: isIncremental
}));

/**
 * Parse task content to extract structured data
 */
function parseTask(content, isCompleted) {
  let title = content;
  let priority = null;
  let stage = null;
  const topics = [];
  let dueDate = null;
  let scheduledDate = null;
  let createdDate = null;
  let completedAt = null;
  let recurrence = null;

  // Extract priority emoji
  for (const [emoji, level] of Object.entries(priorityMap)) {
    if (content.includes(emoji)) {
      priority = level;
      title = title.replace(emoji, '');
      break;
    }
  }

  // Extract stage tag
  const stageMatch = content.match(/#stage\/(front-stage|back-stage|off-stage)/);
  if (stageMatch) {
    stage = stageMatch[1];
    title = title.replace(stageMatch[0], '');
  }

  // Extract topic tags
  const topicMatches = content.matchAll(/#topic\/([a-z_-]+)/g);
  for (const match of topicMatches) {
    topics.push(match[1]);
    title = title.replace(match[0], '');
  }

  // Extract dates
  // Due date: 📅 YYYY-MM-DD
  const dueDateMatch = content.match(/📅 (\d{4}-\d{2}-\d{2})/);
  if (dueDateMatch) {
    dueDate = dueDateMatch[1];
    title = title.replace(dueDateMatch[0], '');
  }

  // Scheduled date: ⏳ YYYY-MM-DD
  const scheduledMatch = content.match(/⏳ (\d{4}-\d{2}-\d{2})/);
  if (scheduledMatch) {
    scheduledDate = scheduledMatch[1];
    title = title.replace(scheduledMatch[0], '');
  }

  // Created date: ➕ YYYY-MM-DD
  const createdMatch = content.match(/➕ (\d{4}-\d{2}-\d{2})/);
  if (createdMatch) {
    createdDate = createdMatch[1];
    title = title.replace(createdMatch[0], '');
  }

  // Completed date: ✅ YYYY-MM-DD
  const completedMatch = content.match(/✅ (\d{4}-\d{2}-\d{2})/);
  if (completedMatch) {
    // Convert date to ISO datetime (assume end of day in local timezone)
    completedAt = `${completedMatch[1]}T23:59:59`;
    title = title.replace(completedMatch[0], '');
  }

  // Recurrence: 🔁 every day/week/month/etc.
  const recurrenceMatch = content.match(/🔁 ([^\s#]+(?:\s+[^\s#]+)*)/);
  if (recurrenceMatch) {
    recurrence = recurrenceMatch[1].trim();
    title = title.replace(/🔁 [^\s#]+(?:\s+[^\s#]+)*/, '');
  }

  // Clean up title - remove extra whitespace
  title = title.replace(/\s+/g, ' ').trim();

  return {
    title,
    priority,
    stage,
    topics,
    dueDate,
    scheduledDate,
    createdDate,
    completedAt,
    recurrence
  };
}
