#!/usr/bin/env node

// Task Timer - Pomodoro-style cycling through today's tasks with background sync.
//
// Usage: node vault/scripts/task-timer.js [minutes]
//
// Arguments:
//   minutes   Work period in minutes (default: 2). Rest = 10% of work.
//
// Controls:
//   Space - Pause/Resume
//   s     - Skip to next task
//   n     - Skip to next phase (work->rest or rest->next task)
//   q     - Quit
//
// Features:
//   - Sync at start of each timer to update remaining tasks
//   - Automatic removal of completed/rescheduled tasks
//   - Re-shuffling of remaining tasks after sync

import { getDatabase } from '../../src/database-service.js';
import { getTodayDate } from '../../src/date-utils.js';
import { exec } from 'child_process';
import { promisify } from 'util';

// ANSI helpers
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const CYAN = '\x1b[96m';
const GRAY = '\x1b[90m';

// Parse arguments
const workMinutes = parseFloat(process.argv[2]) || 2;
const workSeconds = Math.round(workMinutes * 60);
const restSeconds = Math.round(workSeconds * 0.1);

// Global state for task management
let remainingItems = [];
let currentSyncId = 0;

// Fetch today's tasks from the database
function getTodayTasks(db) {
  const today = getTodayDate();
  return db.prepare(`
    SELECT title, priority
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
}

// Fetch today's pending habits from the database
function getPendingHabits(db) {
  const today = getTodayDate();
  return db.prepare(`
    SELECT title, category
    FROM habits
    WHERE date = ?
      AND status = 'pending'
      AND (goal_type IS NULL OR goal_type != 'limit')
      AND (json_extract(metadata, '$.recurrence') IS NULL
           OR json_extract(metadata, '$.recurrence') = 'daily')
      AND habit_id != 'evening'
    ORDER BY category, title
  `).all(today);
}

// Fetch projects needing review from the database
function getProjectsForReview(db) {
  const today = getTodayDate();
  return db.prepare(`
    SELECT title, priority, review_frequency, last_reviewed,
           julianday(?) - julianday(last_reviewed) as days_since
    FROM projects
    WHERE status IN ('active', 'planning')
      AND review_frequency IS NOT NULL
      AND (
        last_reviewed IS NULL
        OR (review_frequency = 'daily' AND julianday(?) - julianday(last_reviewed) >= 1)
        OR (review_frequency = 'weekly' AND julianday(?) - julianday(last_reviewed) >= 7)
        OR (review_frequency = 'monthly' AND julianday(?) - julianday(last_reviewed) >= 30)
        OR (review_frequency = 'quarterly' AND julianday(?) - julianday(last_reviewed) >= 90)
        OR (review_frequency = 'yearly' AND julianday(?) - julianday(last_reviewed) >= 365)
      )
    ORDER BY
      CASE
        WHEN last_reviewed IS NULL THEN 0
        ELSE julianday(?) - julianday(last_reviewed)
      END DESC
  `).all(today, today, today, today, today, today, today);
}

// Shuffle array in place (Fisher-Yates)
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Data sync and refresh functions ---

async function syncAndRebuildItemsAsync(syncId) {
  const execAsync = promisify(exec);

  // Check if this sync was cancelled
  if (syncId !== currentSyncId) {
    return null; // Cancelled
  }

  try {
    // Sync data like script startup (non-blocking)
    await execAsync('bin/plugins sync --type tasks', { stdio: 'pipe' });

    // Check again after first sync in case it was cancelled during execution
    if (syncId !== currentSyncId) {
      return null;
    }

    await execAsync('bin/plugins sync --type projects', { stdio: 'pipe' });

    if (syncId !== currentSyncId) {
      return null;
    }

    await execAsync('bin/plugins sync --type habits', { stdio: 'pipe' });

    if (syncId !== currentSyncId) {
      return null;
    }

    // Rebuild entire items list from scratch (like script startup)
    const db = getDatabase();
    const tasks = getTodayTasks(db);
    const projects = getProjectsForReview(db);
    const habits = getPendingHabits(db);

    const newItems = [];

    // Build items list exactly like script startup
    for (const t of tasks) {
      const emoji = PRIORITY_EMOJI[t.priority] || ' ';
      newItems.push({ label: `${emoji} ${t.title}`, type: 'task' });
    }
    for (const p of projects) {
      const emoji = PRIORITY_EMOJI[p.priority] || ' ';
      const daysSince = p.days_since != null ? Math.floor(p.days_since) : null;
      const reviewNote = daysSince != null ? `(${daysSince}d since review)` : '(never reviewed)';
      newItems.push({ label: `${emoji} ${p.title} ${GRAY}${reviewNote}${RESET}`, type: 'project' });
    }
    for (const h of habits) {
      const categoryNote = h.category ? `${GRAY}(${h.category})${RESET}` : '';
      newItems.push({ label: `${h.title} ${categoryNote}`, type: 'habit' });
    }

    // Final check before returning results
    if (syncId !== currentSyncId) {
      return null;
    }

    // Shuffle like script startup
    shuffle(newItems);

    return newItems;
  } catch (error) {
    return null; // Sync failed, keep current items
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const PRIORITY_EMOJI = {
  highest: '\u{1F53A}', // 🔺
  high: '\u23EB',       // ⏫
  medium: '\u{1F53C}',  // 🔼
  low: '\u{1F53D}',     // 🔽
  lowest: '\u23EC',     // ⏬
};

// --- Input handling ---

let paused = false;
let skipTask = false;
let skipPhase = false;
let quit = false;

function setupInput() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === ' ') paused = !paused;
    else if (key === 's') skipTask = true;
    else if (key === 'n') skipPhase = true;
    else if (key === 'q' || key === '\u0003') quit = true; // q or Ctrl+C
  });
}

function teardownInput() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

// --- Countdown ---

function countdown(seconds, label, color) {
  return new Promise((resolve) => {
    let remaining = seconds;

    const tick = () => {
      if (quit) { resolve(false); return; }
      if (skipTask || skipPhase) { skipPhase = false; resolve(false); return; }

      if (paused) {
        process.stdout.write(`\r${color}[PAUSED]${RESET} ${label}: ${formatTime(remaining)}  `);
        setTimeout(tick, 100);
        return;
      }

      process.stdout.write(`\r${color}${label}: ${formatTime(remaining)}${RESET}  `);

      if (remaining <= 0) {
        process.stdout.write('\n');
        resolve(true);
        return;
      }

      remaining--;
      setTimeout(tick, 1000);
    };

    tick();
  });
}

// --- Main ---

async function main() {
  // Initial sync and setup (like script startup)
  console.log(`${GRAY}Initial sync...${RESET}`);
  const initialItems = await syncAndRebuildItemsAsync(++currentSyncId);
  remainingItems = initialItems || [];

  if (remainingItems.length === 0) {
    console.log('Nothing due today.');
    process.exit(0);
  }

  console.log(`\n${BOLD}Task Timer${RESET}`);
  console.log(`Work: ${formatTime(workSeconds)} | Rest: ${formatTime(restSeconds)}`);
  console.log(`\n${YELLOW}Controls: [Space] Pause  [s] Skip task  [n] Next phase  [q] Quit${RESET}`);

  setupInput();

  try {
    let currentIndex = 0;
    let backgroundSync = null;

    while (currentIndex < remainingItems.length && !quit) {
      if (remainingItems.length === 0) {
        console.log(`\n${GREEN}${BOLD}All tasks completed!${RESET}\n`);
        break;
      }

      const item = remainingItems[currentIndex];
      const wasSkipped = skipTask;
      skipTask = false;

      // If user skipped, cancel current sync and start fresh
      if (wasSkipped) {
        currentSyncId++; // This cancels any in-progress sync
        backgroundSync = null;
      }

      // Check if previous background sync completed and update items
      if (backgroundSync) {
        backgroundSync.then((newItems) => {
          if (newItems && !quit) {
            remainingItems = newItems;
          }
        });
        backgroundSync = null;
      }

      // Print task header
      const typeTags = { task: 'TASK', habit: 'HABIT', project: 'PROJECT REVIEW' };
      const typeTag = `${CYAN}${typeTags[item.type] || 'TASK'}${RESET}`;
      console.log(`\n${BOLD}${'━'.repeat(50)}${RESET}`);
      console.log(`${typeTag} ${GRAY}${currentIndex + 1}/${remainingItems.length}${RESET}`);
      console.log(`${BOLD}${item.label}${RESET}`);
      console.log(`${BOLD}${'━'.repeat(50)}${RESET}\n`);

      // Start background sync for next timer (truly background, don't wait)
      backgroundSync = syncAndRebuildItemsAsync(currentSyncId);

      // Work phase (sync runs in background during this)
      if (!skipTask && !quit) {
        await countdown(workSeconds, 'WORK', GREEN);
      }

      // If user skipped during countdown, cancel the sync
      if (skipTask) {
        currentSyncId++;
        backgroundSync = null;
      }

      // Rest phase (skip on last item, or if task was skipped)
      if (!skipTask && !quit && currentIndex < remainingItems.length - 1) {
        await countdown(restSeconds, 'REST', YELLOW);
      }

      // Check again after rest phase
      if (skipTask) {
        currentSyncId++;
        backgroundSync = null;
      }

      currentIndex++;
    }

    if (!quit) {
      console.log(`\n${GREEN}${BOLD}All done!${RESET}\n`);
    }
  } finally {
    teardownInput();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
