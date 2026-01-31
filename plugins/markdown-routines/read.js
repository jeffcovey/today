#!/usr/bin/env node

/**
 * markdown-routines plugin
 *
 * Syncs routines from vault/routines/*.md files to the habits table.
 * Each routine file contains:
 * - YAML front matter with name, recurrence, estimated_minutes, history
 * - Markdown tasks with scheduled dates (⏳ YYYY-MM-DD)
 *
 * On sync:
 * - If scheduled date is in the past and we're in a new period:
 *   - Record completion stats to history
 *   - Reset all tasks to unchecked
 *   - Update scheduled dates to current period
 * - Output entries for the habits table
 */

import fs from 'fs';
import path from 'path';
import { parseRecurrence, getCurrentPeriodStart, getNextPeriodStart, formatDate } from '../../src/recurrence-parser.js';
import { TZDate } from '@date-fns/tz';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

const routinesDirectory = config.routines_directory || `${process.env.VAULT_PATH}/routines`;
const historyLimit = config.history_limit || 30;

// Get timezone from global config
const globalConfigPath = path.join(projectRoot, 'config.toml');
let configuredTimezone = 'America/New_York'; // Default
try {
  const tomlContent = fs.readFileSync(globalConfigPath, 'utf8');
  const tzMatch = tomlContent.match(/^timezone\s*=\s*"([^"]+)"/m);
  if (tzMatch) {
    configuredTimezone = tzMatch[1];
  }
} catch {
  // Use default
}

const routinesDir = path.join(projectRoot, routinesDirectory);

// Get today's date in the configured timezone
function getToday() {
  const now = new TZDate(new Date(), configuredTimezone);
  // Create a date-only representation (midnight in the configured timezone)
  return new TZDate(now.getFullYear(), now.getMonth(), now.getDate(), configuredTimezone);
}

// Get today's date string in YYYY-MM-DD format
function getTodayStr() {
  const now = new TZDate(new Date(), configuredTimezone);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Parse YAML front matter from markdown
function parseFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return { frontMatter: {}, body: content };
  }

  const yaml = match[1];
  const body = content.slice(match[0].length).trim();

  // Simple YAML parser for our needs
  const frontMatter = {};
  let currentKey = null;
  let currentArray = null;
  let inArray = false;

  for (const line of yaml.split('\n')) {
    // Array item
    if (line.match(/^\s+-\s/)) {
      if (inArray && currentArray !== null) {
        // Parse array item as object or string
        const itemContent = line.replace(/^\s+-\s*/, '');
        if (itemContent.includes(':')) {
          // Object item - parse key-value pairs
          const obj = {};
          // Handle inline object: "- date: 2025-12-15"
          const inlineMatch = itemContent.match(/^(\w+):\s*(.*)$/);
          if (inlineMatch) {
            obj[inlineMatch[1]] = parseValue(inlineMatch[2]);
          }
          currentArray.push(obj);
        } else {
          currentArray.push(parseValue(itemContent));
        }
      }
      continue;
    }

    // Continuation of array object (indented key: value)
    if (line.match(/^\s{4,}\w+:/) && inArray && currentArray?.length > 0) {
      const match = line.match(/^\s+(\w+):\s*(.*)$/);
      if (match) {
        const lastItem = currentArray[currentArray.length - 1];
        if (typeof lastItem === 'object') {
          lastItem[match[1]] = parseValue(match[2]);
        }
      }
      continue;
    }

    // Top-level key
    const keyMatch = line.match(/^(\w+):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      const value = keyMatch[2].trim();

      if (value === '') {
        // Could be array or nested object - check next line
        frontMatter[currentKey] = [];
        currentArray = frontMatter[currentKey];
        inArray = true;
      } else {
        frontMatter[currentKey] = parseValue(value);
        inArray = false;
        currentArray = null;
      }
    }
  }

  return { frontMatter, body };
}

// Parse a YAML value
function parseValue(str) {
  if (str === 'true') return true;
  if (str === 'false') return false;
  if (str === 'null' || str === '') return null;
  if (str === '[]') return [];  // Empty array
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d*\.\d+$/.test(str)) return parseFloat(str);
  // Remove quotes
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  return str;
}

// Serialize front matter back to YAML
function serializeFrontMatter(fm) {
  const lines = ['---'];

  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          // Object array item
          const keys = Object.keys(item);
          if (keys.length > 0) {
            lines.push(`  - ${keys[0]}: ${serializeValue(item[keys[0]])}`);
            for (let i = 1; i < keys.length; i++) {
              lines.push(`    ${keys[i]}: ${serializeValue(item[keys[i]])}`);
            }
          }
        } else {
          lines.push(`  - ${serializeValue(item)}`);
        }
      }
    } else {
      lines.push(`${key}: ${serializeValue(value)}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

// Serialize a value for YAML
function serializeValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    // Quote if contains special chars
    if (value.includes(':') || value.includes('#') || value.includes('\n')) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}

// Find all tasks in markdown body and extract scheduled dates
function findTasks(body) {
  const tasks = [];
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match tasks: - [ ] or - [x]
    const taskMatch = line.match(/^(\s*-\s*\[)([ xX])(\].*)$/);
    if (taskMatch) {
      const isCompleted = taskMatch[2].toLowerCase() === 'x';
      // Extract scheduled date: ⏳ YYYY-MM-DD
      const dateMatch = line.match(/⏳\s*(\d{4}-\d{2}-\d{2})/);
      const scheduledDate = dateMatch ? dateMatch[1] : null;

      tasks.push({
        lineIndex: i,
        line: line,
        isCompleted,
        scheduledDate,
        prefix: taskMatch[1],
        checkbox: taskMatch[2],
        suffix: taskMatch[3]
      });
    }
  }

  return tasks;
}

// Reset all tasks to unchecked and update scheduled dates
function resetTasks(body, tasks, newDate) {
  const lines = body.split('\n');
  const newDateStr = formatDate(newDate);

  for (const task of tasks) {
    let line = lines[task.lineIndex];

    // Reset checkbox to unchecked
    line = line.replace(/^(\s*-\s*\[)[ xX](\].*)$/, '$1 $2');

    // Update or add scheduled date
    if (task.scheduledDate) {
      line = line.replace(/⏳\s*\d{4}-\d{2}-\d{2}/, `⏳ ${newDateStr}`);
    } else {
      // Add scheduled date before any existing emoji dates or at end
      const emojiDatePos = line.search(/[➕✅🛫⏳]\s*\d{4}-\d{2}-\d{2}/);
      if (emojiDatePos > -1) {
        line = line.slice(0, emojiDatePos) + `⏳ ${newDateStr} ` + line.slice(emojiDatePos);
      } else {
        line = line + ` ⏳ ${newDateStr}`;
      }
    }

    lines[task.lineIndex] = line;
  }

  return lines.join('\n');
}

// Calculate streak from history (consecutive 100% completions)
function calculateStreak(history, todayStr) {
  if (!history || history.length === 0) return 0;

  // Sort by date descending
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));

  let streak = 0;

  for (const entry of sorted) {
    // Skip future dates
    if (entry.date > todayStr) continue;

    // Check if 100% completed
    if (entry.completed === entry.total) {
      streak++;
    } else {
      // Streak broken
      break;
    }
  }

  return streak;
}

// Process a single routine file
function processRoutine(filePath, today) {
  const content = fs.readFileSync(filePath, 'utf8');
  const { frontMatter, body } = parseFrontMatter(content);

  const routineId = path.basename(filePath, '.md');
  const name = frontMatter.name || routineId;
  const recurrence = frontMatter.recurrence || 'daily';
  const estimatedMinutes = frontMatter.estimated_minutes || null;
  const history = frontMatter.history || [];

  // Find all tasks
  const tasks = findTasks(body);
  const totalTasks = tasks.length;

  if (totalTasks === 0) {
    return {
      entry: null,
      modified: false,
      error: `No tasks found in ${routineId}`
    };
  }

  // Get scheduled date from first task that has one
  const scheduledDate = tasks.find(t => t.scheduledDate)?.scheduledDate;
  const todayStr = getTodayStr();

  let modified = false;
  let newBody = body;
  let newHistory = [...history];

  // Determine if the current period starts today (e.g. daily, weekday on a weekday)
  // vs. started in the past (e.g. monthly on the 1st when today is the 15th).
  // This controls both the scheduled date and reset condition:
  //
  // Period starts today (daily-like):
  //   ⏳ = today, reset fires tomorrow via scheduledDate < todayStr
  //   History records scheduledDate directly (the day work was done)
  //
  // Period started in past (weekly/monthly/quarterly/yearly):
  //   ⏳ = next period start, reset fires that day via scheduledDate <= todayStr
  //   History records current period start (the period work was done in)
  const parsed = parseRecurrence(recurrence);
  const currentPeriodStart = getCurrentPeriodStart(parsed, today);
  const currentPeriodStr = formatDate(currentPeriodStart);
  const periodStartsToday = currentPeriodStr === todayStr;

  const needsReset = scheduledDate && (
    periodStartsToday
      ? scheduledDate < todayStr      // yesterday < today
      : scheduledDate <= todayStr     // next period start has arrived
  );

  if (needsReset) {
    // Count completed tasks
    const completedTasks = tasks.filter(t => t.isCompleted).length;

    // Record history for the period the work was done in
    let historyDate;
    if (periodStartsToday) {
      // Daily-like: scheduledDate is the day work was done
      historyDate = scheduledDate;
    } else {
      // Non-daily: scheduledDate is the next period start, so the completed
      // period is the one containing the day before the scheduled date
      const scheduledDateObj = new TZDate(scheduledDate + 'T00:00:00', configuredTimezone);
      const dayBefore = new TZDate(
        scheduledDateObj.getFullYear(), scheduledDateObj.getMonth(),
        scheduledDateObj.getDate() - 1, configuredTimezone
      );
      historyDate = formatDate(getCurrentPeriodStart(parsed, dayBefore));
    }

    newHistory.unshift({
      date: historyDate,
      completed: completedTasks,
      total: totalTasks
    });

    // Trim history
    if (newHistory.length > historyLimit) {
      newHistory = newHistory.slice(0, historyLimit);
    }

    // Schedule for today if period starts today, otherwise next period
    const newDate = periodStartsToday ? currentPeriodStart : getNextPeriodStart(parsed, today);

    // Reset tasks and update dates
    newBody = resetTasks(body, tasks, newDate);
    modified = true;
  }

  // Write back if modified
  if (modified) {
    const newFrontMatter = {
      ...frontMatter,
      history: newHistory
    };
    const newContent = serializeFrontMatter(newFrontMatter) + '\n\n' + newBody;
    fs.writeFileSync(filePath, newContent, 'utf8');
  }

  // Re-read tasks after potential reset
  const currentTasks = modified ? findTasks(newBody) : tasks;
  const currentCompleted = currentTasks.filter(t => t.isCompleted).length;
  const currentTotal = currentTasks.length;

  // Determine status
  let status = 'pending';
  if (currentCompleted === currentTotal) {
    status = 'completed';
  } else if (currentCompleted > 0) {
    status = 'partial';
  }

  // Calculate streak
  const streak = calculateStreak(newHistory, todayStr);

  // Build entry for habits table
  const entry = {
    id: `markdown-routines/${routineId}:${todayStr}`,
    habit_id: routineId,
    title: name,
    date: todayStr,
    status: status,
    goal_type: 'achieve',
    value: currentCompleted,
    category: 'routine',
    metadata: JSON.stringify({
      target_type: 'steps',
      target_value: currentTotal,
      current_streak: streak,
      estimated_minutes: estimatedMinutes,
      completion_pct: Math.round((currentCompleted / currentTotal) * 100),
      recurrence: recurrence
    })
  };

  return {
    entry,
    modified,
    history: newHistory
  };
}

// Sample morning routine template
function getSampleMorningRoutine(todayStr) {
  return `---
name: Morning Routine
recurrence: daily
estimated_minutes: 30
history: []
---

## Start the Day

- [ ] Review calendar - Check today's schedule ⏳ ${todayStr}
- [ ] Check messages - Email, chat, notifications ⏳ ${todayStr}
- [ ] Set top 3 priorities - Focus your day ⏳ ${todayStr}

## Self-Care

- [ ] Drink water - Hydrate first thing ⏳ ${todayStr}
- [ ] Light exercise or stretching ⏳ ${todayStr}
- [ ] Mindfulness moment - Breathe or journal ⏳ ${todayStr}
`;
}

// Main
const entries = [];
const errors = [];
const processed = [];
let createdSample = null;

// Create routines directory if it doesn't exist
if (!fs.existsSync(routinesDir)) {
  fs.mkdirSync(routinesDir, { recursive: true });
}

// Find all .md files in routines directory
let files = fs.readdirSync(routinesDir)
  .filter(f => f.endsWith('.md'))
  .map(f => path.join(routinesDir, f));

// Create sample routine if none exist
if (files.length === 0) {
  const todayStr = formatDate(getToday());
  const samplePath = path.join(routinesDir, 'morning.md');
  fs.writeFileSync(samplePath, getSampleMorningRoutine(todayStr), 'utf8');
  files = [samplePath];
  // Store relative path from project root for user display
  createdSample = path.join(routinesDirectory, 'morning.md');
}

const today = getToday();

for (const file of files) {
  try {
    const result = processRoutine(file, today);

    if (result.entry) {
      entries.push(result.entry);
      processed.push({
        routine: path.basename(file, '.md'),
        modified: result.modified,
        status: result.entry.status
      });
    }

    if (result.error) {
      errors.push(result.error);
    }
  } catch (error) {
    errors.push(`Error processing ${path.basename(file)}: ${error.message}`);
  }
}

// Output
console.log(JSON.stringify({
  entries: entries,
  metadata: {
    routines_count: files.length,
    entries_count: entries.length,
    processed: processed,
    created_sample: createdSample || undefined,
    errors: errors.length > 0 ? errors : undefined
  }
}));
