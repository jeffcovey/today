#!/usr/bin/env node
/**
 * CLI Task Timer
 *
 * Outputs today's open tasks and pending habits as a JSON array, applying the
 * same task_timer.exclude_files / task_timer.exclude_habits config filters as
 * the web timer widget (src/web-server.js).
 *
 * Usage:
 *   node vault/scripts/task-timer.js
 *   node vault/scripts/task-timer.js --text   # plain-text output
 *
 * Config (config.toml):
 *   [task_timer]
 *   exclude_files  = ["routines/evening.md"]  # filter tasks by source file path
 *   exclude_habits = ["evening"]              # filter habits by habit_id
 */

import { getDatabase } from '../../src/database-service.js';
import { getConfig, getVaultPath } from '../../src/config.js';
import { getTodayDate } from '../../src/date-utils.js';

const db = getDatabase();
const today = getTodayDate();

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

function getTodayTasks() {
  const tasks = db.prepare(`
    SELECT id, title, priority, source
    FROM tasks
    WHERE status = 'open'
      AND (due_date <= ? OR json_extract(metadata, '$.scheduled_date') <= ?)
    ORDER BY
      CASE priority
        WHEN 'highest' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
        WHEN 'lowest' THEN 5
        ELSE 6
      END,
      due_date NULLS LAST
  `).all(today, today);

  // Filter out tasks from excluded files (vault-relative paths)
  const excludeFiles = getConfig('task_timer.exclude_files') || [];
  const vaultPrefix = getVaultPath() + '/';
  return excludeFiles.length > 0
    ? tasks.filter(task => !excludeFiles.some(f => task.id.includes(vaultPrefix + f)))
    : tasks;
}

function getPendingHabits() {
  const habits = db.prepare(`
    SELECT habit_id, title, category
    FROM habits
    WHERE date = ?
      AND status = 'pending'
      AND (goal_type IS NULL OR goal_type != 'limit')
      AND (json_extract(metadata, '$.recurrence') IS NULL
           OR json_extract(metadata, '$.recurrence') = 'daily')
    ORDER BY category, title
  `).all(today);

  // Filter out habits with excluded habit IDs (replaces any hardcoded exclusions)
  const excludeHabits = getConfig('task_timer.exclude_habits') || [];
  return excludeHabits.length > 0
    ? habits.filter(habit => !excludeHabits.includes(habit.habit_id))
    : habits;
}

// ---------------------------------------------------------------------------
// Build item list
// ---------------------------------------------------------------------------

const tasks = getTodayTasks();
const habits = getPendingHabits();

const priorityEmoji = {
  highest: '🔺',
  high: '⏫',
  medium: '🔼',
  low: '🔽',
  lowest: '⏬',
};

const items = [];

for (const task of tasks) {
  const emoji = priorityEmoji[task.priority] || '';
  items.push({
    id: `task-${task.id}`,
    type: 'task',
    title: task.title,
    displayText: emoji ? `${emoji} ${task.title}` : task.title,
    priority: task.priority || null,
  });
}

for (const habit of habits) {
  items.push({
    id: `habit-${habit.habit_id}`,
    type: 'habit',
    title: habit.title,
    displayText: habit.title + (habit.category ? ` (${habit.category})` : ''),
    category: habit.category || null,
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (process.argv.includes('--text')) {
  for (const item of items) {
    const tag = item.type === 'habit' ? '[habit]' : '[task] ';
    console.log(`${tag} ${item.displayText}`);
  }
} else {
  console.log(JSON.stringify(items, null, 2));
}
