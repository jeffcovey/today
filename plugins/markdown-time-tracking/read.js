#!/usr/bin/env node

// Sync time tracking entries from markdown files
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries and metadata

import fs from 'fs';
import path from 'path';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const lastSyncTime = process.env.LAST_SYNC_TIME || '';
const daysToSync = config.days_to_sync || 365;
const directory = config.directory || 'vault/logs/time-tracking';

const timeDir = path.join(projectRoot, directory);

// Calculate cutoff date
const cutoffDate = new Date();
cutoffDate.setDate(cutoffDate.getDate() - daysToSync);
const cutoffYearMonth = cutoffDate.toISOString().substring(0, 7);

// Parse last sync time
const lastSyncDate = lastSyncTime ? new Date(lastSyncTime) : null;

// Find markdown files
let allFiles;
try {
  allFiles = fs.readdirSync(timeDir)
    .filter(f => f.match(/^\d{4}-\d{2}\.md$/))
    .filter(f => f.substring(0, 7) >= cutoffYearMonth)
    .map(f => ({
      name: f,
      path: path.join(timeDir, f),
      relativePath: path.join(directory, f)
    }));
} catch (error) {
  console.error(JSON.stringify({ error: `Cannot read directory: ${error.message}` }));
  process.exit(1);
}

// Check which files need syncing based on modification time
let filesToSync = allFiles;
let isIncremental = false;

if (lastSyncDate) {
  filesToSync = allFiles.filter(f => {
    const stat = fs.statSync(f.path);
    return stat.mtime > lastSyncDate;
  });
  isIncremental = true;
}

// Parse entries from files that need syncing
const entries = [];
const filesProcessed = [];

for (const file of filesToSync) {
  filesProcessed.push(file.relativePath);
  const content = fs.readFileSync(file.path, 'utf8');
  const lines = content.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (!line || line.startsWith('#')) continue;

    const parts = line.split('|');
    if (parts.length < 3) continue;

    const [start, end, description] = parts;
    if (!start || !description) continue;

    const duration = calculateDuration(start.trim(), end?.trim());

    entries.push({
      // Include file path and line number for unique ID
      id: `${file.relativePath}:${lineNum}`,
      start_time: start.trim(),
      end_time: end?.trim() || null,
      duration_minutes: duration,
      description: description.trim()
    });
  }
}

// Also check current-timer.md for running timer
const currentTimerFile = path.join(timeDir, 'current-timer.md');
const currentTimerRelPath = path.join(directory, 'current-timer.md');

if (fs.existsSync(currentTimerFile)) {
  // Check if current-timer was modified since last sync (or always include if full sync)
  const shouldIncludeTimer = !lastSyncDate || fs.statSync(currentTimerFile).mtime > lastSyncDate;

  if (shouldIncludeTimer) {
    // Always include this file in filesProcessed when modified
    // This ensures the DB entry is deleted when timer is stopped (file becomes empty)
    filesProcessed.push(currentTimerRelPath);

    const content = fs.readFileSync(currentTimerFile, 'utf8').trim();
    if (content) {
      const lines = content.split('\n');
      if (lines.length >= 2) {
        const description = lines[0];
        const startTime = lines[1];

        entries.push({
          id: `${currentTimerRelPath}:0`,
          start_time: startTime,
          end_time: null,
          duration_minutes: 0,
          description: description
        });
      }
    }
  }
}

// Output JSON in new incremental format
console.log(JSON.stringify({
  entries,
  files_processed: filesProcessed,
  incremental: isIncremental
}));

function calculateDuration(start, end) {
  if (!end) return 0;
  try {
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    return Math.floor((endTime - startTime) / 60000);
  } catch {
    return 0;
  }
}
