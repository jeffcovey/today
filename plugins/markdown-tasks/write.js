#!/usr/bin/env node

// Write task operations to markdown files
// Input: ENTRY_JSON environment variable with entry data
// Output: JSON with success status
//
// Supported actions:
// - add: Add a new task to tasks.md
// - complete: Mark a task as completed
// - update: Update a task's properties

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { writeFileAtomic, writeFileAtomicCAS } from '../../src/fs-atomic.js';
import {
  buildLedger,
  compareTaskLines,
  ledgerExpired,
  listTaskFamily,
  planSortedInsert,
  repairFromLedger
} from '../../src/task-files.js';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const entryJson = process.env.ENTRY_JSON || '';

const directory = config.directory || process.env.VAULT_PATH;
const defaultTaskFile = config.default_task_file || `${process.env.VAULT_PATH}/tasks/tasks.md`;

// Priority mappings
const priorityToEmoji = {
  highest: '🔺',
  high: '⏫',
  medium: '🔼',
  low: '🔽',
  lowest: '⏬'
};

const emojiToPriority = Object.fromEntries(
  Object.entries(priorityToEmoji).map(([k, v]) => [v, k])
);

// Parse entry
let entry;
try {
  entry = JSON.parse(entryJson);
} catch (error) {
  console.log(JSON.stringify({ success: false, error: `Invalid ENTRY_JSON: ${error.message}` }));
  process.exit(1);
}

// Validate action
const action = entry.action || 'add';
if (!['add', 'complete', 'update', 'classify-stages', 'add-date-created', 'add-priority', 'archive-completed', 'guard-ledger'].includes(action)) {
  console.log(JSON.stringify({ success: false, error: `Invalid action: ${action}` }));
  process.exit(1);
}

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate() {
  const now = new Date();
  return now.toISOString().substring(0, 10);
}

/**
 * Build a task line from structured data
 */
function buildTaskLine(task) {
  let line = `- [ ] ${task.title}`;

  // Add created date only if user has enabled it or explicitly provided one
  if (task.created_date || config.auto_add_date_created) {
    const createdDate = task.created_date || getTodayDate();
    line += ` ➕ ${createdDate}`;
  }

  // Add priority
  if (task.priority && priorityToEmoji[task.priority]) {
    line += ` ${priorityToEmoji[task.priority]}`;
  }

  // Add stage
  if (task.stage) {
    line += ` #stage/${task.stage}`;
  }

  // Add topics
  if (task.topics && task.topics.length > 0) {
    for (const topic of task.topics) {
      line += ` #topic/${topic}`;
    }
  }

  // Add scheduled date
  if (task.scheduled_date) {
    line += ` ⏳ ${task.scheduled_date}`;
  }

  // Add due date
  if (task.due_date) {
    line += ` 📅 ${task.due_date}`;
  }

  // Add recurrence
  if (task.recurrence) {
    line += ` 🔁 ${task.recurrence}`;
  }

  return line;
}

/**
 * Mark a task line as completed
 */
function markCompleted(line) {
  // Replace [ ] with [x]
  let newLine = line.replace(/^- \[ \]/, '- [x]');

  // Add completion date
  const completedDate = getTodayDate();
  if (!newLine.includes('✅')) {
    newLine += ` ✅ ${completedDate}`;
  }

  return newLine;
}

/**
 * Extract the core title from a task line for matching
 * Strips checkbox, priority, tags, dates, etc.
 */
function extractTitle(line) {
  return line
    .replace(/^- \[[x ]\] /, '')      // Remove checkbox
    .replace(/<!--.*?-->/g, '')        // Remove HTML comments (Obsidian IDs)
    .replace(/[🔺⏫🔼🔽⏬]/g, '')      // Remove priority
    .replace(/#\w+\/[\w-]+/g, '')     // Remove tags
    .replace(/[➕📅⏳✅🔁]\s*\d{4}-\d{2}-\d{2}/g, '') // Remove dates
    .replace(/🔁 [^\s#]+(?:\s+[^\s#]+)*/g, '') // Remove recurrence
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a line matches the expected title
 */
function lineMatchesTitle(line, expectedTitle) {
  const lineTitle = extractTitle(line);
  // Normalize expected title too (may contain HTML comments from database)
  const normalizedExpected = expectedTitle
    .replace(/<!--.*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Case-insensitive comparison
  return lineTitle.toLowerCase() === normalizedExpected.toLowerCase();
}

/**
 * Find a task by title in the file, returns line index (0-based) or -1
 */
function findTaskByTitle(lines, title) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^- \[ \]/) && lineMatchesTitle(lines[i], title)) {
      return i;
    }
  }
  return -1;
}

try {
  if (action === 'add') {
    // ADD: Append new task to default task file
    if (!entry.title) {
      console.log(JSON.stringify({ success: false, error: 'Missing required field: title' }));
      process.exit(1);
    }

    const taskFile = path.join(projectRoot, defaultTaskFile);
    const taskDir = path.dirname(taskFile);

    // Ensure directory exists
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }

    // Build task line
    const taskLine = buildTaskLine(entry);

    // Alphabetized task files: put the task at its sorted place in the file
    // whose range covers it, so the nightly rebalance has little to move.
    if (config.auto_archive_completed && fs.existsSync(taskFile)) {
      const [planned] = planSortedInsert(taskFile, [taskLine]);
      const { conflict } = writeFileAtomicCAS(planned.path, planned.lines.join('\n') + '\n', planned.original ?? '');
      if (conflict) {
        console.log(JSON.stringify({
          success: false,
          error: 'Concurrent update to task file; retry',
          concurrent_update: true,
          file: planned.path
        }));
        process.exit(1);
      }
      console.log(JSON.stringify({
        success: true,
        action: 'add',
        file: planned.path,
        line: taskLine,
        needs_sync: true
      }));
      process.exit(0);
    }

    // Read existing content
    let content = '';
    let fileExists = true;
    try {
      content = fs.readFileSync(taskFile, 'utf8');
    } catch {
      // File doesn't exist yet
      fileExists = false;
    }

    // Append task
    const lines = content.split('\n').filter(l => l.trim());
    lines.push(taskLine);
    const newContent = lines.join('\n') + '\n';

    if (fileExists) {
      const { conflict } = writeFileAtomicCAS(taskFile, newContent, content);
      if (conflict) {
        console.log(JSON.stringify({
          success: false,
          error: 'Concurrent update to task file; retry',
          concurrent_update: true,
          file: taskFile
        }));
        process.exit(1);
      }
    } else {
      try {
        fs.writeFileSync(taskFile, newContent, { encoding: 'utf8', flag: 'wx' });
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw err;
        }
        // Another instance created the file first; re-read and CAS append.
        const fresh = fs.readFileSync(taskFile, 'utf8');
        const freshLines = fresh.split('\n').filter(l => l.trim());
        freshLines.push(taskLine);
        const { conflict } = writeFileAtomicCAS(taskFile, freshLines.join('\n') + '\n', fresh);
        if (conflict) {
          console.log(JSON.stringify({
            success: false,
            error: 'Concurrent update to task file; retry',
            concurrent_update: true,
            file: taskFile
          }));
          process.exit(1);
        }
      }
    }

    console.log(JSON.stringify({
      success: true,
      action: 'add',
      file: taskFile,
      line: taskLine,
      needs_sync: true  // Database should be refreshed to include new task
    }));
    process.exit(0);

  } else if (action === 'complete') {
    // COMPLETE: Find and mark task as done
    // Accepts: id (file:line), title (for verification or search), or both
    if (!entry.id && !entry.title) {
      console.log(JSON.stringify({ success: false, error: 'Missing required field: id or title' }));
      process.exit(1);
    }

    let filePath, lineNumber, lineIndex;
    let lineNumberShifted = false;

    // Parse ID if provided
    if (entry.id && entry.id.includes(':')) {
      const parts = entry.id.split(':');
      lineNumber = parseInt(parts.pop());
      filePath = path.join(projectRoot, parts.join(':'));
    }

    if (!filePath) {
      console.log(JSON.stringify({ success: false, error: 'File path required (provide id with file:line format)' }));
      process.exit(1);
    }

    if (!fs.existsSync(filePath)) {
      console.log(JSON.stringify({ success: false, error: `File not found: ${filePath}` }));
      process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    // Try to find the task
    if (lineNumber && lineNumber >= 1 && lineNumber <= lines.length) {
      lineIndex = lineNumber - 1;
      const lineAtPosition = lines[lineIndex];

      // If we have a title to verify against, check it matches
      if (entry.title) {
        if (lineAtPosition.match(/^- \[ \]/) && lineMatchesTitle(lineAtPosition, entry.title)) {
          // Line number is correct and title matches
        } else {
          // Line number is stale - search for the task by title
          const foundIndex = findTaskByTitle(lines, entry.title);
          if (foundIndex >= 0) {
            lineIndex = foundIndex;
            lineNumber = foundIndex + 1;
            lineNumberShifted = true;
          } else {
            console.log(JSON.stringify({
              success: false,
              error: `Task not found: "${entry.title}" (line ${lineNumber} contains different content)`,
              needs_sync: true
            }));
            process.exit(1);
          }
        }
      } else if (!lineAtPosition.match(/^- \[ \]/)) {
        // No title provided and line is not an open task
        console.log(JSON.stringify({
          success: false,
          error: `Line ${lineNumber} is not an open task. Provide 'title' for safer matching.`,
          needs_sync: true
        }));
        process.exit(1);
      }
    } else if (entry.title) {
      // No valid line number, search by title
      const foundIndex = findTaskByTitle(lines, entry.title);
      if (foundIndex >= 0) {
        lineIndex = foundIndex;
        lineNumber = foundIndex + 1;
        lineNumberShifted = true;
      } else {
        console.log(JSON.stringify({
          success: false,
          error: `Task not found: "${entry.title}"`
        }));
        process.exit(1);
      }
    } else {
      console.log(JSON.stringify({ success: false, error: `Line ${lineNumber} out of range` }));
      process.exit(1);
    }

    const originalLine = lines[lineIndex];
    lines[lineIndex] = markCompleted(originalLine);
    const { conflict: completeConflict } = writeFileAtomicCAS(filePath, lines.join('\n'), content);
    if (completeConflict) {
      console.log(JSON.stringify({
        success: false,
        error: 'Concurrent update to task file; retry',
        concurrent_update: true,
        file: filePath
      }));
      process.exit(1);
    }

    console.log(JSON.stringify({
      success: true,
      action: 'complete',
      file: filePath,
      line_number: lineNumber,
      original_line: originalLine,
      new_line: lines[lineIndex],
      line_shifted: lineNumberShifted,
      needs_sync: true  // Always recommend sync after modifications
    }));

  } else if (action === 'update') {
    // UPDATE: Modify an existing task
    if (!entry.id) {
      console.log(JSON.stringify({ success: false, error: 'Missing required field: id' }));
      process.exit(1);
    }

    // ID format: file_path:line_number
    const parts = entry.id.split(':');
    const lineNumber = parseInt(parts.pop());
    const filePath = path.join(projectRoot, parts.join(':'));

    if (!fs.existsSync(filePath)) {
      console.log(JSON.stringify({ success: false, error: `File not found: ${filePath}` }));
      process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    if (lineNumber < 1 || lineNumber > lines.length) {
      console.log(JSON.stringify({ success: false, error: `Line ${lineNumber} out of range` }));
      process.exit(1);
    }

    const lineIndex = lineNumber - 1;
    const originalLine = lines[lineIndex];

    if (!originalLine.match(/^- \[[ x]\]/)) {
      console.log(JSON.stringify({ success: false, error: `Line ${lineNumber} is not a task` }));
      process.exit(1);
    }

    // Parse existing task and merge updates
    const isCompleted = originalLine.match(/^- \[x\]/);
    let newLine = originalLine;

    // Update title if provided
    if (entry.title) {
      // Replace the title portion (between checkbox and first marker)
      newLine = newLine.replace(
        /^(- \[[x ]\] )([^➕📅⏳✅🔁#]+)/,
        `$1${entry.title} `
      );
    }

    // Update priority if provided
    if (entry.priority) {
      // Remove existing priority
      newLine = newLine.replace(/[🔺⏫🔼🔽⏬]/g, '');
      // Add new priority after title
      const emoji = priorityToEmoji[entry.priority];
      if (emoji) {
        newLine = newLine.replace(/(- \[[x ]\] [^➕]+)(➕)/, `$1${emoji} $2`);
      }
    }

    // Update due date if provided
    if (entry.due_date) {
      if (newLine.includes('📅')) {
        newLine = newLine.replace(/📅 \d{4}-\d{2}-\d{2}/, `📅 ${entry.due_date}`);
      } else {
        newLine += ` 📅 ${entry.due_date}`;
      }
    }

    // Update scheduled date if provided
    if (entry.scheduled_date) {
      if (newLine.includes('⏳')) {
        newLine = newLine.replace(/⏳ \d{4}-\d{2}-\d{2}/, `⏳ ${entry.scheduled_date}`);
      } else {
        newLine += ` ⏳ ${entry.scheduled_date}`;
      }
    }

    lines[lineIndex] = newLine;
    const { conflict: updateConflict } = writeFileAtomicCAS(filePath, lines.join('\n'), content);
    if (updateConflict) {
      console.log(JSON.stringify({
        success: false,
        error: 'Concurrent update to task file; retry',
        concurrent_update: true,
        file: filePath
      }));
      process.exit(1);
    }

    console.log(JSON.stringify({
      success: true,
      action: 'update',
      file: filePath,
      line_number: lineNumber,
      original_line: originalLine,
      new_line: newLine,
      needs_sync: true  // Database should be refreshed to reflect changes
    }));

  } else if (action === 'classify-stages') {
    // CLASSIFY-STAGES: Add stage tags to tasks without them
    // Input: { tasks: [{id, title, file_path, line_number}], use_ai: true, limit: 100 }
    const tasks = entry.tasks || [];
    const useAI = entry.use_ai !== false;
    const limit = entry.limit || null;
    const BATCH_SIZE = 20;

    if (tasks.length === 0) {
      console.log(JSON.stringify({ success: true, action: 'classify-stages', classified: 0, files_modified: [] }));
      process.exit(0);
    }

    // Check if Claude CLI is available for AI classification
    let claudeAvailable = false;
    if (useAI) {
      try {
        execSync('which claude', { encoding: 'utf8' });
        claudeAvailable = true;
      } catch {
        // Claude not available, fall back to keyword matching
      }
    }

    // Group tasks by file
    const tasksByFile = new Map();
    let tasksToProcess = limit ? tasks.slice(0, limit) : tasks;

    for (const task of tasksToProcess) {
      const filePath = path.join(projectRoot, task.file_path);
      if (!tasksByFile.has(filePath)) {
        tasksByFile.set(filePath, []);
      }
      tasksByFile.get(filePath).push(task);
    }

    let totalClassified = 0;
    const filesModified = [];
    const filesSkippedDueToConflict = [];

    for (const [filePath, fileTasks] of tasksByFile) {
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      let modified = false;

      // Prepare tasks for classification
      const tasksToClassify = fileTasks.map(task => ({
        task,
        lineIndex: task.line_number - 1,
        title: extractTitle(lines[task.line_number - 1] || ''),
        line: lines[task.line_number - 1] || ''
      })).filter(t => t.line.match(/^- \[ \]/) && !t.line.includes('#stage/'));

      if (tasksToClassify.length === 0) continue;

      if (claudeAvailable) {
        // AI-powered classification in batches
        for (let i = 0; i < tasksToClassify.length; i += BATCH_SIZE) {
          const batch = tasksToClassify.slice(i, Math.min(i + BATCH_SIZE, tasksToClassify.length));

          const prompt = `Analyze these tasks and classify them into one of three stages based on their nature.

The three stages are:
- front-stage: Tasks involving direct interaction with others (meetings, calls, emails, presentations, customer support, networking)
- back-stage: Solo work tasks (planning, coding, organizing, maintenance, documentation, research, analysis)
- off-stage: Personal time tasks (self-care, health, exercise, relaxation, hobbies, personal relationships)

Respond with a JSON array where each has:
{"index": task_index, "stage": "front-stage|back-stage|off-stage"}

Tasks:
${JSON.stringify(batch.map((t, idx) => ({ index: idx, title: t.title })), null, 2)}`;

          try {
            const result = execSync(`claude --print '${prompt.replace(/'/g, "'\\''")}'`, {
              encoding: 'utf8',
              maxBuffer: 1024 * 1024 * 10,
              timeout: 60000
            });

            const jsonMatch = result.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const classifications = JSON.parse(jsonMatch[0]);

              for (const cls of classifications) {
                const taskInfo = batch[cls.index];
                if (!taskInfo) continue;

                const stage = `#stage/${cls.stage}`;
                let newLine = taskInfo.line;

                // Insert stage after priority emoji if present
                const priorityMatch = newLine.match(/(.*?)(🔺|⏫|🔼|🔽|⏬)(.*)/);
                if (priorityMatch) {
                  newLine = `${priorityMatch[1]}${priorityMatch[2]} ${stage}${priorityMatch[3]}`;
                } else {
                  // Insert before dates or at end
                  const dateMatch = newLine.match(/(.*?)([📅⏳✅] \d{4}-\d{2}-\d{2}.*)/);
                  if (dateMatch) {
                    newLine = `${dateMatch[1]} ${stage} ${dateMatch[2]}`;
                  } else {
                    newLine = `${newLine} ${stage}`;
                  }
                }

                lines[taskInfo.lineIndex] = newLine;
                modified = true;
                totalClassified++;
              }
            }
          } catch (err) {
            // AI failed for this batch, continue with next
          }
        }
      } else {
        // Keyword-based fallback classification
        for (const taskInfo of tasksToClassify) {
          const title = taskInfo.title.toLowerCase();
          let stage;

          if (title.match(/\b(meeting|call|email|support|customer|present|interview|reply|respond)\b/)) {
            stage = 'front-stage';
          } else if (title.match(/\b(fix|bug|maintain|organize|plan|bill|document|setup|code|refactor)\b/)) {
            stage = 'back-stage';
          } else if (title.match(/\b(personal|health|exercise|read|friend|family|relax|self|doctor|gym)\b/)) {
            stage = 'off-stage';
          } else {
            stage = 'back-stage'; // Default
          }

          let newLine = taskInfo.line;

          const stageTag = `#stage/${stage}`;
          const priorityMatch = newLine.match(/(.*?)(🔺|⏫|🔼|🔽|⏬)(.*)/);
          if (priorityMatch) {
            newLine = `${priorityMatch[1]}${priorityMatch[2]} ${stageTag}${priorityMatch[3]}`;
          } else {
            const dateMatch = newLine.match(/(.*?)([📅⏳✅] \d{4}-\d{2}-\d{2}.*)/);
            if (dateMatch) {
              newLine = `${dateMatch[1]} ${stageTag} ${dateMatch[2]}`;
            } else {
              newLine = `${newLine} ${stageTag}`;
            }
          }

          lines[taskInfo.lineIndex] = newLine;
          modified = true;
          totalClassified++;
        }
      }

      if (modified) {
        const { conflict } = writeFileAtomicCAS(filePath, lines.join('\n'), content);
        if (conflict) {
          filesSkippedDueToConflict.push(path.relative(projectRoot, filePath));
        } else {
          filesModified.push(path.relative(projectRoot, filePath));
        }
      }
    }

    console.log(JSON.stringify({
      success: true,
      action: 'classify-stages',
      classified: totalClassified,
      files_modified: filesModified,
      files_skipped_due_to_conflict: filesSkippedDueToConflict,
      used_ai: claudeAvailable,
      needs_sync: filesModified.length > 0
    }));

  } else if (action === 'add-date-created') {
    // Add created date markers to tasks that don't have them
    // Input: { action: 'add-date-created', tasks: [{ id, title, file_path, line_number }] }
    const tasks = entry.tasks || [];

    if (tasks.length === 0) {
      console.log(JSON.stringify({ success: true, action: 'add-date-created', added: 0, files_modified: [] }));
      process.exit(0);
    }

    // Group tasks by file
    const tasksByFile = new Map();
    for (const task of tasks) {
      if (!task.file_path) continue;
      const filePath = path.join(projectRoot, task.file_path);
      if (!tasksByFile.has(filePath)) {
        tasksByFile.set(filePath, []);
      }
      tasksByFile.get(filePath).push(task);
    }

    let totalAdded = 0;
    const filesModified = [];
    const filesSkippedDueToConflict = [];
    const today = getTodayDate();

    for (const [filePath, fileTasks] of tasksByFile) {
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      let modified = false;

      for (const task of fileTasks) {
        const lineIndex = task.line_number - 1;
        if (lineIndex < 0 || lineIndex >= lines.length) continue;

        let line = lines[lineIndex];

        // Skip if already has date created marker
        if (line.includes('➕')) continue;

        // Skip if not a task line
        if (!line.match(/^- \[ \]/)) continue;

        // Insert date created before priority, stage, topic, or other date markers
        const insertPoint = line.match(/(.*?)(🔺|⏫|🔼|🔽|⏬|#stage\/|#topic\/|📅|⏳|✅|🔁|$)/);
        if (insertPoint) {
          const before = insertPoint[1].trimEnd();
          const after = insertPoint[2] + line.slice(insertPoint.index + insertPoint[0].length);
          line = `${before} ➕ ${today}${after ? ' ' + after.trim() : ''}`;
          lines[lineIndex] = line;
          modified = true;
          totalAdded++;
        }
      }

      if (modified) {
        const { conflict } = writeFileAtomicCAS(filePath, lines.join('\n'), content);
        if (conflict) {
          filesSkippedDueToConflict.push(path.relative(projectRoot, filePath));
        } else {
          filesModified.push(path.relative(projectRoot, filePath));
        }
      }
    }

    console.log(JSON.stringify({
      success: true,
      action: 'add-date-created',
      added: totalAdded,
      files_modified: filesModified,
      files_skipped_due_to_conflict: filesSkippedDueToConflict,
      needs_sync: filesModified.length > 0
    }));

  } else if (action === 'add-priority') {
    // Add priority emojis to tasks that don't have them
    // Input: { action: 'add-priority', tasks: [{ id, title, file_path, line_number }], use_ai: boolean }
    const tasks = entry.tasks || [];
    const useAI = entry.use_ai !== false;

    if (tasks.length === 0) {
      console.log(JSON.stringify({ success: true, action: 'add-priority', prioritized: 0, files_modified: [], used_ai: false }));
      process.exit(0);
    }

    // Check if Claude CLI is available
    let claudeAvailable = false;
    if (useAI) {
      try {
        execSync('which claude', { encoding: 'utf8', stdio: 'pipe' });
        claudeAvailable = true;
      } catch {
        // Claude not available, will use keyword fallback
      }
    }

    // Group tasks by file
    const tasksByFile = new Map();
    for (const task of tasks) {
      if (!task.file_path) continue;
      const filePath = path.join(projectRoot, task.file_path);
      if (!tasksByFile.has(filePath)) {
        tasksByFile.set(filePath, []);
      }
      tasksByFile.get(filePath).push(task);
    }

    let totalPrioritized = 0;
    const filesModified = [];
    const filesSkippedDueToConflict = [];

    for (const [filePath, fileTasks] of tasksByFile) {
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      let modified = false;

      // Build list of tasks to prioritize from this file
      const tasksToClassify = [];
      for (const task of fileTasks) {
        const lineIndex = task.line_number - 1;
        if (lineIndex < 0 || lineIndex >= lines.length) continue;

        const line = lines[lineIndex];
        // Skip if already has priority or not a task
        if (!line.match(/^- \[ \]/) || line.match(/🔺|⏫|🔼|🔽|⏬/)) continue;

        tasksToClassify.push({
          lineIndex,
          title: task.title,
          line
        });
      }

      if (tasksToClassify.length === 0) continue;

      if (claudeAvailable) {
        // AI-powered priority assignment
        const BATCH_SIZE = 20;

        for (let i = 0; i < tasksToClassify.length; i += BATCH_SIZE) {
          const batch = tasksToClassify.slice(i, Math.min(i + BATCH_SIZE, tasksToClassify.length));

          const prompt = `Analyze these tasks and assign priority emojis based on urgency and importance.

Use EXACTLY these priority emojis:
- 🔺 (Highest) - Urgent and critical (health emergencies, critical deadlines, system failures)
- ⏫ (High) - Important and time-sensitive (upcoming deadlines, scheduled meetings, important fixes)
- 🔼 (Medium) - Regular priority (most daily tasks, routine work)
- 🔽 (Low) - Nice to have (someday/maybe items, research, exploration)
- ⏬ (Lowest) - Reference or optional (archived ideas, distant future)

Respond with a JSON array where each has:
{"index": task_index, "priority": "emoji"}

Tasks:
${JSON.stringify(batch.map((t, idx) => ({ index: idx, title: t.title })), null, 2)}`;

          try {
            const result = execSync(`claude --print '${prompt.replace(/'/g, "'\\''")}'`, {
              encoding: 'utf8',
              maxBuffer: 1024 * 1024 * 10,
              timeout: 60000
            });

            const jsonMatch = result.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const classifications = JSON.parse(jsonMatch[0]);

              for (const cls of classifications) {
                const taskInfo = batch[cls.index];
                if (!taskInfo || !cls.priority) continue;

                // Validate priority emoji
                if (!['🔺', '⏫', '🔼', '🔽', '⏬'].includes(cls.priority)) continue;

                let newLine = taskInfo.line;

                // Insert priority after "- [ ] title" but before tags/dates
                const match = newLine.match(/^(- \[ \] [^#➕📅⏳✅🔁]+)(.*)/);
                if (match) {
                  newLine = `${match[1].trimEnd()} ${cls.priority}${match[2] ? ' ' + match[2].trim() : ''}`;
                  lines[taskInfo.lineIndex] = newLine;
                  modified = true;
                  totalPrioritized++;
                }
              }
            }
          } catch {
            // AI failed for this batch, continue
          }
        }
      } else {
        // Keyword-based fallback priority assignment
        for (const taskInfo of tasksToClassify) {
          const title = taskInfo.title.toLowerCase();
          let priority;

          if (title.match(/\b(urgent|critical|emergency|asap|immediately|blocker)\b/)) {
            priority = '🔺';
          } else if (title.match(/\b(important|high|soon|priority|deadline|meeting|call|appointment)\b/)) {
            priority = '⏫';
          } else if (title.match(/\b(someday|maybe|consider|explore|research|idea)\b/)) {
            priority = '🔽';
          } else if (title.match(/\b(archive|reference|optional|distant)\b/)) {
            priority = '⏬';
          } else {
            priority = '🔼'; // Default to medium
          }

          let newLine = taskInfo.line;
          const match = newLine.match(/^(- \[ \] [^#➕📅⏳✅🔁]+)(.*)/);
          if (match) {
            newLine = `${match[1].trimEnd()} ${priority}${match[2] ? ' ' + match[2].trim() : ''}`;
            lines[taskInfo.lineIndex] = newLine;
            modified = true;
            totalPrioritized++;
          }
        }
      }

      if (modified) {
        const { conflict } = writeFileAtomicCAS(filePath, lines.join('\n'), content);
        if (conflict) {
          filesSkippedDueToConflict.push(path.relative(projectRoot, filePath));
        } else {
          filesModified.push(path.relative(projectRoot, filePath));
        }
      }
    }

    console.log(JSON.stringify({
      success: true,
      action: 'add-priority',
      prioritized: totalPrioritized,
      files_modified: filesModified,
      files_skipped_due_to_conflict: filesSkippedDueToConflict,
      used_ai: claudeAvailable,
      needs_sync: filesModified.length > 0
    }));

  } else if (action === 'archive-completed' || action === 'guard-ledger') {
    // guard-ledger (every sync): put back what a file sync undid after the
    // last rebalance, using the ledger that rebalance wrote.
    // archive-completed (nightly): the same repair, then archive completed
    // tasks, then sort the family across its files — when a file overflows,
    // or always with sort_all. A ledger is written before any file moves.
    // Uses default_task_file as the base for naming:
    //   tasks.md -> tasks-archive.md, tasks-1.md, tasks-2.md, ...
    const maxTasksPerFile = entry.max_tasks_per_file || 50;

    const taskFile = path.join(projectRoot, defaultTaskFile);
    const taskDir = path.dirname(taskFile);
    const taskBaseName = path.basename(taskFile, '.md');
    const archiveFile = path.join(taskDir, `${taskBaseName}-archive.md`);
    const ledgerFile = path.join(
      projectRoot,
      '.data',
      'task-ledgers',
      `${crypto.createHash('sha1').update(taskFile).digest('hex').slice(0, 12)}.json`
    );
    const rel = filePath => path.relative(projectRoot, filePath);
    const nonBlank = content => (content ?? '').split('\n').filter(line => line.trim());
    const readOrNull = filePath => {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    };

    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }

    const filesModified = new Set();
    const filesSkippedDueToConflict = [];

    // 1. Repair from the last ledger.
    let ledger = null;
    try {
      ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    } catch {
      ledger = null;
    }
    if (ledger && ledgerExpired(ledger)) {
      try { fs.unlinkSync(ledgerFile); } catch { /* already gone */ }
      ledger = null;
    }

    let restored = [];
    let removed = [];
    if (ledger) {
      const family = listTaskFamily(taskFile);
      const originals = new Map(family.map(filePath => [path.basename(filePath), readOrNull(filePath)]));
      const current = family.map(filePath => ({
        name: path.basename(filePath),
        lines: nonBlank(originals.get(path.basename(filePath)))
      }));
      const archiveLines = nonBlank(readOrNull(archiveFile));
      const archiveSince = archiveLines.length >= ledger.archive_length
        ? archiveLines.slice(ledger.archive_length)
        : archiveLines;
      const repair = repairFromLedger(ledger, current, archiveSince);
      for (const [name, lines] of Object.entries(repair.files)) {
        const filePath = path.join(taskDir, name);
        const { conflict } = writeFileAtomicCAS(filePath, lines.length ? lines.join('\n') + '\n' : '', originals.get(name) ?? '');
        if (conflict) {
          filesSkippedDueToConflict.push(rel(filePath));
          continue;
        }
        filesModified.add(rel(filePath));
      }
      if (filesSkippedDueToConflict.length === 0) {
        restored = repair.restored;
        removed = repair.removed;
      }
    }

    if (action === 'guard-ledger') {
      console.log(JSON.stringify({
        success: true,
        action: 'guard-ledger',
        restored,
        removed,
        files_modified: Array.from(filesModified),
        files_skipped_due_to_conflict: filesSkippedDueToConflict,
        needs_sync: filesModified.size > 0
      }));
      process.exit(0);
    }

    // 2. Archive completed tasks from the family and repeating.md.
    const repeatingFile = path.join(taskDir, 'repeating.md');
    const archiveSources = [...listTaskFamily(taskFile), ...(fs.existsSync(repeatingFile) ? [repeatingFile] : [])];
    // A completed line archived by the previous run and back in a source file
    // (a sync reverted the truncation) is dropped from the source, not archived twice.
    const alreadyArchived = new Set(ledger?.archived || []);
    const archiveContent = readOrNull(archiveFile);
    const sourceUpdates = [];
    const pendingArchive = [];
    const pendingSet = new Set();

    for (const filePath of archiveSources) {
      const content = readOrNull(filePath);
      if (content === null) continue;
      const completed = [];
      const remaining = [];
      for (const line of content.split('\n')) {
        if (/^- \[x\]/i.test(line)) completed.push(line);
        else if (line.trim()) remaining.push(line);
      }
      if (completed.length === 0) continue;
      sourceUpdates.push({ filePath, originalContent: content, remainingContent: remaining.join('\n') + '\n' });
      for (const line of completed) {
        if (alreadyArchived.has(line) || pendingSet.has(line)) continue;
        pendingSet.add(line);
        pendingArchive.push(line);
      }
    }

    let archiveLength = nonBlank(archiveContent).length;
    if (pendingArchive.length > 0) {
      // Write archive first so we never lose completed tasks.
      const archiveTasks = nonBlank(archiveContent).concat(pendingArchive);
      archiveLength = archiveTasks.length;
      const archiveBytes = archiveTasks.join('\n') + '\n';
      if (archiveContent !== null) {
        if (writeFileAtomicCAS(archiveFile, archiveBytes, archiveContent).conflict) {
          console.log(JSON.stringify({
            success: false,
            error: 'Concurrent update to archive file; retry',
            concurrent_update: true,
            file: archiveFile,
            files_modified: Array.from(filesModified),
            files_skipped_due_to_conflict: filesSkippedDueToConflict
          }));
          process.exit(1);
        }
      } else {
        writeFileAtomic(archiveFile, archiveBytes);
      }
      filesModified.add(rel(archiveFile));
    }

    // CAS-truncate source files. Conflicts here leave benign duplicates
    // (still-completed source lines + archived copy), never loss.
    for (const update of sourceUpdates) {
      const { conflict } = writeFileAtomicCAS(update.filePath, update.remainingContent, update.originalContent);
      if (conflict) {
        filesSkippedDueToConflict.push(rel(update.filePath));
        continue;
      }
      filesModified.add(rel(update.filePath));
    }

    // 3. Sort and spread the family across its files.
    let rebalanced = false;
    let rebalanceInfo = null;

    const family = listTaskFamily(taskFile);
    const familyContents = family.map(readOrNull);
    const familyLines = familyContents.map(nonBlank);
    const allTasks = familyLines.flat();
    // Never consolidate underflow into fewer files: that silently deleted
    // numbered files the user was still using (#289).
    const anyFileOverflows = familyLines.some(lines => lines.length > maxTasksPerFile);
    const sortAll = entry.sort_all === true;

    let newLedger = null;
    if (allTasks.length > 0 && (anyFileOverflows || sortAll)) {
      const sorted = [...allTasks].sort(compareTaskLines);
      const numberedPattern = new RegExp(`^${taskBaseName}-(\\d+)\\.md$`);
      const targets = [];

      if (anyFileOverflows) {
        const numFiles = Math.max(Math.ceil(sorted.length / maxTasksPerFile), family.length);
        // Spread evenly so no file is anywhere near the max afterwards.
        const perFile = Math.ceil(sorted.length / numFiles);
        let nextNum = Math.max(0, ...family.slice(1).map(f => Number(path.basename(f).match(numberedPattern)[1]))) + 1;
        for (let i = 0; i < numFiles; i++) {
          const filePath = family[i] || path.join(taskDir, `${taskBaseName}-${nextNum++}.md`);
          targets.push({ path: filePath, lines: sorted.slice(i * perFile, (i + 1) * perFile) });
        }
      } else {
        // Keep each file's size so only order moves.
        let offset = 0;
        family.forEach((filePath, i) => {
          targets.push({ path: filePath, lines: sorted.slice(offset, offset + familyLines[i].length) });
          offset += familyLines[i].length;
        });
      }

      const before = Object.fromEntries(family.map((filePath, i) => [path.basename(filePath), familyLines[i]]));
      const after = Object.fromEntries(targets.map(t => [path.basename(t.path), t.lines]));
      const toWrite = targets.filter(t => {
        const index = family.indexOf(t.path);
        const existing = index === -1 ? null : familyContents[index];
        return existing !== t.lines.join('\n') + '\n';
      });

      if (toWrite.length > 0) {
        newLedger = buildLedger({ before, after, archived: pendingArchive, archiveLength });
        fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
        writeFileAtomic(ledgerFile, JSON.stringify(newLedger, null, 2) + '\n');

        // Crash-safe write: rename each target to a .rebalance-bak-<ts> first,
        // then write the new distribution, then drop the backups. If a write
        // throws, restore the backups so the vault is never left with deleted-
        // but-unreplaced files.
        const backups = [];
        const rebalanceSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        for (const target of toWrite) {
          if (!fs.existsSync(target.path)) continue;
          const backupPath = `${target.path}.rebalance-bak-${rebalanceSuffix}`;
          try {
            fs.renameSync(target.path, backupPath);
            backups.push({ original: target.path, backup: backupPath });
          } catch (renameError) {
            // File vanished between exists() and rename(); safe to skip.
            if (renameError.code !== 'ENOENT') throw renameError;
          }
        }

        const writtenPaths = [];
        try {
          for (const target of toWrite) {
            writeFileAtomic(target.path, target.lines.length ? target.lines.join('\n') + '\n' : '');
            writtenPaths.push(target.path);
            filesModified.add(rel(target.path));
          }
        } catch (writeError) {
          // Remove the new writes first, then restore the originals, so a
          // late failure can't leave new numbered files beside restored ones.
          for (const filePath of writtenPaths) {
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best effort */ }
          }
          for (const { original, backup } of backups) {
            try { fs.renameSync(backup, original); } catch { /* best effort */ }
          }
          try { fs.unlinkSync(ledgerFile); } catch { /* best effort */ }
          throw writeError;
        }

        for (const { backup } of backups) {
          try { fs.unlinkSync(backup); } catch { /* best effort */ }
        }

        rebalanced = true;
        rebalanceInfo = {
          total_tasks: allTasks.length,
          files_created: targets.length,
          files_written: toWrite.length,
          max_per_file: maxTasksPerFile,
          distribution: targets.map(t => ({ file: path.basename(t.path), task_count: t.lines.length }))
        };
      }
    }

    // Without a rebalance, still remember what was archived so a reverted
    // truncation can't archive it twice; keep the old ledger's moves.
    if (!newLedger && pendingArchive.length > 0) {
      const kept = ledger || buildLedger({ before: {}, after: {}, archiveLength });
      const merged = { ...kept, archived: [...(kept.archived || []), ...pendingArchive] };
      fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
      writeFileAtomic(ledgerFile, JSON.stringify(merged, null, 2) + '\n');
    }

    console.log(JSON.stringify({
      success: true,
      action: 'archive-completed',
      archived: pendingArchive.length,
      rebalanced,
      rebalance_info: rebalanceInfo,
      restored,
      removed,
      files_modified: Array.from(filesModified),
      files_skipped_due_to_conflict: filesSkippedDueToConflict,
      needs_sync: filesModified.size > 0
    }));

  }

} catch (error) {
  console.log(JSON.stringify({ success: false, error: `Failed to write: ${error.message}` }));
  process.exit(1);
}
