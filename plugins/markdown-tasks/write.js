#!/usr/bin/env node

// Write task operations to markdown files
// Input: ENTRY_JSON environment variable with entry data
// Output: JSON with success status
//
// Supported actions:
// - add: Add a new task to tasks.md
// - complete: Mark a task as completed
// - update: Update a task's properties

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

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
if (!['add', 'complete', 'update', 'classify-stages', 'add-date-created', 'add-priority', 'archive-completed'].includes(action)) {
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
    .replace(/[🔺⏫🔼🔽⏬]/g, '')      // Remove priority
    .replace(/#\w+\/[\w-]+/g, '')     // Remove tags
    .replace(/[➕📅⏳✅🔁] \d{4}-\d{2}-\d{2}/g, '') // Remove dates
    .replace(/🔁 [^\s#]+(?:\s+[^\s#]+)*/g, '') // Remove recurrence
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a line matches the expected title
 */
function lineMatchesTitle(line, expectedTitle) {
  const lineTitle = extractTitle(line);
  // Case-insensitive comparison, normalize whitespace
  return lineTitle.toLowerCase() === expectedTitle.toLowerCase().trim();
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

    // Read existing content
    let content = '';
    try {
      content = fs.readFileSync(taskFile, 'utf8');
    } catch {
      // File doesn't exist yet
    }

    // Append task
    const lines = content.split('\n').filter(l => l.trim());
    lines.push(taskLine);
    fs.writeFileSync(taskFile, lines.join('\n') + '\n');

    console.log(JSON.stringify({
      success: true,
      action: 'add',
      file: taskFile,
      line: taskLine,
      needs_sync: true  // Database should be refreshed to include new task
    }));

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
    fs.writeFileSync(filePath, lines.join('\n'));

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
    fs.writeFileSync(filePath, lines.join('\n'));

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
        fs.writeFileSync(filePath, lines.join('\n'));
        filesModified.push(path.relative(projectRoot, filePath));
      }
    }

    console.log(JSON.stringify({
      success: true,
      action: 'classify-stages',
      classified: totalClassified,
      files_modified: filesModified,
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
        fs.writeFileSync(filePath, lines.join('\n'));
        filesModified.push(path.relative(projectRoot, filePath));
      }
    }

    console.log(JSON.stringify({
      success: true,
      action: 'add-date-created',
      added: totalAdded,
      files_modified: filesModified,
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
        fs.writeFileSync(filePath, lines.join('\n'));
        filesModified.push(path.relative(projectRoot, filePath));
      }
    }

    console.log(JSON.stringify({
      success: true,
      action: 'add-priority',
      prioritized: totalPrioritized,
      files_modified: filesModified,
      used_ai: claudeAvailable,
      needs_sync: filesModified.length > 0
    }));

  } else if (action === 'archive-completed') {
    // Archive completed tasks and rebalance task files
    // Uses default_task_file as the base for naming:
    //   tasks.md -> tasks-archive.md, tasks-1.md, tasks-2.md, ...
    //   inbox.md -> inbox-archive.md, inbox-1.md, inbox-2.md, ...
    const maxTasksPerFile = entry.max_tasks_per_file || 50;

    const taskFile = path.join(projectRoot, defaultTaskFile);
    const taskDir = path.dirname(taskFile);
    const taskBaseName = path.basename(taskFile, '.md');
    const archiveFile = path.join(taskDir, `${taskBaseName}-archive.md`);

    // Ensure directory exists
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }

    // Read current archive file
    let archiveContent = '';
    try {
      archiveContent = fs.readFileSync(archiveFile, 'utf8');
    } catch {
      // Archive file doesn't exist yet
    }

    let archiveTasks = archiveContent.split('\n').filter(line => line.trim());
    let totalArchived = 0;

    // Find all task files: base file, numbered files, and repeating.md
    let allFiles;
    try {
      allFiles = fs.readdirSync(taskDir);
    } catch {
      allFiles = [];
    }

    // Match: tasks.md, tasks-1.md, tasks-2.md, repeating.md (but not tasks-archive.md)
    const taskFilePattern = new RegExp(`^(${taskBaseName}\\.md|${taskBaseName}-(\\d+)\\.md|repeating\\.md)$`);
    const taskFiles = allFiles
      .filter(f => taskFilePattern.test(f) && !f.includes('-archive'))
      .map(f => path.join(taskDir, f))
      .sort();

    if (taskFiles.length === 0) {
      console.log(JSON.stringify({
        success: true,
        action: 'archive-completed',
        archived: 0,
        rebalanced: false,
        files_modified: [],
        needs_sync: false
      }));
      process.exit(0);
    }

    const filesModified = new Set();

    // Process each task file - archive completed tasks
    for (const filePath of taskFiles) {
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split('\n');

      // Separate completed from incomplete tasks
      const completedTasks = [];
      const remainingLines = [];

      for (const line of lines) {
        if (line.match(/^- \[x\]/i)) {
          completedTasks.push(line);
          totalArchived++;
        } else if (line.trim()) {
          remainingLines.push(line);
        }
      }

      // Add completed tasks to archive
      if (completedTasks.length > 0) {
        archiveTasks = archiveTasks.concat(completedTasks);

        // Write back remaining tasks
        fs.writeFileSync(filePath, remainingLines.join('\n') + '\n');
        filesModified.add(path.relative(projectRoot, filePath));
      }
    }

    if (totalArchived > 0) {
      // Write updated archive file
      fs.writeFileSync(archiveFile, archiveTasks.join('\n') + '\n');
      filesModified.add(path.relative(projectRoot, archiveFile));
    }

    // Now rebalance main task file if it exceeds max tasks
    let rebalanced = false;
    let rebalanceInfo = null;

    if (fs.existsSync(taskFile)) {
      const tasksContent = fs.readFileSync(taskFile, 'utf8');
      const tasksLines = tasksContent.split('\n').filter(line => line.trim());

      if (tasksLines.length > maxTasksPerFile) {
        // Keep first maxTasksPerFile, move the rest
        const toKeep = tasksLines.slice(0, maxTasksPerFile);
        const toMove = tasksLines.slice(maxTasksPerFile);

        // Find existing numbered files and their task counts
        const numberedFilePattern = new RegExp(`^${taskBaseName}-(\\d+)\\.md$`);
        const numberedFiles = allFiles
          .filter(f => numberedFilePattern.test(f))
          .map(f => {
            const num = parseInt(f.match(numberedFilePattern)[1]);
            return { num, file: f };
          })
          .sort((a, b) => a.num - b.num);

        // Find a file with room (< maxTasksPerFile tasks) or create a new one
        let targetFile = null;
        let targetNum = null;

        for (const { num, file } of numberedFiles) {
          const filePath = path.join(taskDir, file);
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').filter(line => line.trim());

            if (lines.length < maxTasksPerFile) {
              targetFile = filePath;
              targetNum = num;
              break;
            }
          } catch {
            // Skip files that can't be read
          }
        }

        // If no file has room, create a new one
        if (!targetFile) {
          targetNum = numberedFiles.length > 0 ? numberedFiles[numberedFiles.length - 1].num + 1 : 1;
          targetFile = path.join(taskDir, `${taskBaseName}-${targetNum}.md`);
        }

        // Read target file and append tasks
        let targetContent = '';
        try {
          targetContent = fs.readFileSync(targetFile, 'utf8');
        } catch {
          // File doesn't exist yet
        }

        const targetLines = targetContent.split('\n').filter(line => line.trim());
        const combinedLines = targetLines.concat(toMove);

        // Write files
        fs.writeFileSync(taskFile, toKeep.join('\n') + '\n');
        fs.writeFileSync(targetFile, combinedLines.join('\n') + '\n');

        filesModified.add(path.relative(projectRoot, taskFile));
        filesModified.add(path.relative(projectRoot, targetFile));

        rebalanced = true;
        rebalanceInfo = {
          moved: toMove.length,
          from: path.basename(taskFile),
          to: path.basename(targetFile),
          main_count: toKeep.length,
          target_count: combinedLines.length
        };
      }
    }

    console.log(JSON.stringify({
      success: true,
      action: 'archive-completed',
      archived: totalArchived,
      rebalanced,
      rebalance_info: rebalanceInfo,
      files_modified: Array.from(filesModified),
      needs_sync: filesModified.size > 0
    }));
  }

} catch (error) {
  console.log(JSON.stringify({ success: false, error: `Failed to write: ${error.message}` }));
  process.exit(1);
}
