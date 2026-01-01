#!/usr/bin/env node

// Sync habits from Streaks app backup files (.streaks)
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries (one per habit per day)

import fs from 'fs';
import path from 'path';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

const logsDirectory = config.logs_directory || `${process.env.VAULT_PATH}/logs`;
const retentionDays = config.retention_days || 30;
const cleanupOldFiles = config.cleanup_old_files || false;

const logsDir = path.join(projectRoot, logsDirectory);

// Find the latest .streaks file
function findLatestStreaksFile() {
  if (!fs.existsSync(logsDir)) {
    return null;
  }

  const files = fs.readdirSync(logsDir)
    .filter(f => f.endsWith('.streaks'))
    .map(f => ({
      name: f,
      path: path.join(logsDir, f),
      // Extract timestamp from filename: "iPhone - 20251213T162603.streaks"
      timestamp: f.match(/(\d{8}T\d{6})\.streaks$/)?.[1] || ''
    }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return files[0]?.path || null;
}

// Delete all .streaks files except the latest one
function cleanupOldStreaksFiles(latestFile) {
  if (!fs.existsSync(logsDir)) return [];

  const deleted = [];
  const files = fs.readdirSync(logsDir)
    .filter(f => f.endsWith('.streaks'))
    .map(f => path.join(logsDir, f))
    .filter(f => f !== latestFile);

  for (const file of files) {
    try {
      fs.unlinkSync(file);
      deleted.push(path.basename(file));
    } catch (error) {
      // Ignore deletion errors
    }
  }

  return deleted;
}

// Parse date from YYYYMMDD integer to YYYY-MM-DD string
function formatDate(dateInt) {
  const str = String(dateInt);
  return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
}

// Get today's date as YYYYMMDD integer in specified timezone
function getTodayInt(timezone = 'America/New_York') {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  // en-CA gives YYYY-MM-DD format
  const dateStr = formatter.format(now).replace(/-/g, '');
  return parseInt(dateStr);
}

// Get cutoff date as YYYYMMDD integer (retention_days ago)
function getCutoffInt(retentionDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const year = cutoff.getFullYear();
  const month = String(cutoff.getMonth() + 1).padStart(2, '0');
  const day = String(cutoff.getDate()).padStart(2, '0');
  return parseInt(`${year}${month}${day}`);
}

// Calculate current streak for a habit from its log
function calculateStreak(log, todayInt, isLimitHabit = false) {
  if (!log || log.length === 0) return 0;

  // Completed types: 1 = completed_manually, 2 = completed_auto
  // For limit habits, also count 15 (missed_auto_partial) as success - under limit is good
  const successTypes = isLimitHabit ? [1, 2, 15] : [1, 2];

  // Group entries by date and check if any entry is a success
  const byDate = {};
  for (const entry of log) {
    if (!byDate[entry.d]) {
      byDate[entry.d] = false;
    }
    if (successTypes.includes(entry.t)) {
      byDate[entry.d] = true;
    }
  }

  // Get unique dates sorted descending
  const dates = Object.keys(byDate).map(Number).sort((a, b) => b - a);

  let streak = 0;
  let expectedDate = todayInt;

  for (const date of dates) {
    // Skip future dates
    if (date > todayInt) continue;

    // If there's a gap, streak is broken
    if (date < expectedDate) break;

    // Check if this date was completed
    if (byDate[date]) {
      streak++;
      // Calculate previous day
      const dateStr = String(date);
      const d = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`);
      d.setDate(d.getDate() - 1);
      expectedDate = parseInt(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
    } else {
      // Not completed, streak is broken
      break;
    }
  }

  return streak;
}

// Determine status from log entry type
function getStatus(logType) {
  // Status types from Streaks (via CSV export):
  // 1 = completed_manually
  // 2 = completed_auto (HealthKit goal met)
  // 4 = skipped_auto / skipped_manually
  // 5 = missed_auto / missed_manually
  // 7 = timer_manually (timer session, partial)
  // 9 = HealthKit sync event (ignore)
  // 11 = completed_manually_partial
  // 15 = missed_auto_partial (HealthKit progress, goal not met)
  switch (logType) {
    case 1:
    case 2:
      return 'completed';
    case 4:
      return 'skipped';
    case 7:
    case 11:
    case 15:
      return 'partial';
    default:
      return 'skipped'; // 5 = missed, others unknown
  }
}

// Main
const streaksFile = findLatestStreaksFile();

if (!streaksFile) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      error: 'No .streaks file found',
      logs_directory: logsDirectory
    }
  }));
  process.exit(0);
}

// Read and parse the file
let data;
try {
  const content = fs.readFileSync(streaksFile, 'utf8');
  data = JSON.parse(content);
} catch (error) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      error: `Failed to parse ${path.basename(streaksFile)}: ${error.message}`
    }
  }));
  process.exit(0);
}

// Build category lookup
const categories = {};
for (const cat of data.categories || []) {
  categories[cat.id] = cat.t; // id -> title
}

const todayInt = getTodayInt();
const cutoffInt = getCutoffInt(retentionDays);
const entries = [];

// Process each habit (task in Streaks terminology)
for (const task of data.tasks || []) {
  const habitId = task.id;
  // Use formatted title (tf) which includes target info, fallback to basic title (t)
  const title = task.tf || task.t;

  // Skip habits without a title (deleted or unknown)
  if (!title) continue;

  // Skip archived habits (st: "A" = archived, "N" = normal/active)
  if (task.st === 'A') continue;

  const icon = task.i;
  const categoryIds = task.cat || [];
  const categoryName = categoryIds.length > 0 ? categories[categoryIds[0]] : null;

  // Get target info if available
  const targetType = task.e?.uab?.t || 'boolean'; // timer, count, boolean
  const targetValue = task.ftpd || null; // frequency times per day?
  const goalType = task.n === true ? 'limit' : 'achieve'; // n: true = negative/limit habit
  const isLimitHabit = goalType === 'limit';

  // Calculate current streak (for limit habits, partial progress counts as success)
  const currentStreak = calculateStreak(task.log, todayInt, isLimitHabit);

  // Process log entries within retention period
  const logEntries = (task.log || []).filter(entry => entry.d >= cutoffInt && entry.d <= todayInt);

  // Group by date (multiple entries per day possible for timer habits)
  const byDate = {};
  for (const entry of logEntries) {
    const dateKey = entry.d;
    if (!byDate[dateKey]) {
      byDate[dateKey] = { totalValue: 0, status: 'skipped', entries: [] };
    }
    byDate[dateKey].entries.push(entry);
    byDate[dateKey].totalValue += entry.p || 0;

    // Take the "best" status for the day
    const entryStatus = getStatus(entry.t);
    if (entryStatus === 'completed') {
      byDate[dateKey].status = 'completed';
    } else if (entryStatus === 'partial' && byDate[dateKey].status !== 'completed') {
      byDate[dateKey].status = 'partial';
    }
  }

  // Create an entry for each date
  for (const [dateInt, dayData] of Object.entries(byDate)) {
    const dateStr = formatDate(parseInt(dateInt));
    const sourceId = `streaks-habits/default:${habitId}:${dateStr}`;

    entries.push({
      id: sourceId,
      habit_id: habitId,
      title: title,
      date: dateStr,
      status: dayData.status,
      goal_type: goalType,
      value: dayData.totalValue > 0 ? dayData.totalValue : null,
      category: categoryName,
      metadata: JSON.stringify({
        icon: icon,
        target_type: targetType,
        target_value: targetValue,
        current_streak: currentStreak,
        entry_count: dayData.entries.length
      })
    });
  }

  // If today has no entries, add a pending entry
  const todayStr = formatDate(todayInt);
  if (!byDate[todayInt]) {
    const sourceId = `streaks-habits/default:${habitId}:${todayStr}`;
    entries.push({
      id: sourceId,
      habit_id: habitId,
      title: title,
      date: todayStr,
      status: 'pending',
      goal_type: goalType,
      value: null,
      category: categoryName,
      metadata: JSON.stringify({
        icon: icon,
        target_type: targetType,
        target_value: targetValue,
        current_streak: currentStreak,
        entry_count: 0
      })
    });
  }
}

// Cleanup old files if enabled
let deletedFiles = [];
if (cleanupOldFiles) {
  deletedFiles = cleanupOldStreaksFiles(streaksFile);
}

// Output
console.log(JSON.stringify({
  entries: entries,
  metadata: {
    source_file: path.basename(streaksFile),
    habits_count: data.tasks?.length || 0,
    entries_count: entries.length,
    retention_days: retentionDays,
    cutoff_date: formatDate(cutoffInt),
    app_version: data.app,
    deleted_files: deletedFiles.length > 0 ? deletedFiles : undefined
  }
}));
