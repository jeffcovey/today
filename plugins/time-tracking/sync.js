#!/usr/bin/env node

// Sync time tracking entries from markdown files
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON array of time entries to stdout

import fs from 'fs';
import path from 'path';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const daysToSync = config.days_to_sync || 365;
const directory = config.directory || 'vault/logs/time-tracking';

const timeDir = path.join(projectRoot, directory);

// Calculate cutoff date
const cutoffDate = new Date();
cutoffDate.setDate(cutoffDate.getDate() - daysToSync);
const cutoffYearMonth = cutoffDate.toISOString().substring(0, 7);

// Find markdown files
let files;
try {
  files = fs.readdirSync(timeDir)
    .filter(f => f.match(/^\d{4}-\d{2}\.md$/))
    .filter(f => f.substring(0, 7) >= cutoffYearMonth)
    .map(f => path.join(timeDir, f));
} catch (error) {
  console.error(JSON.stringify({ error: `Cannot read directory: ${error.message}` }));
  process.exit(1);
}

// Parse entries
const entries = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;

    const parts = line.split('|');
    if (parts.length < 3) continue;

    const [start, end, description] = parts;
    if (!start || !description) continue;

    const topics = (description.match(/#topic\/[a-z_]+/g) || []).join(' ');
    const duration = calculateDuration(start.trim(), end?.trim());

    entries.push({
      start_time: start.trim(),
      end_time: end?.trim() || null,
      duration_minutes: duration,
      description: description.trim(),
      topics: topics || null
    });
  }
}

// Output JSON
console.log(JSON.stringify(entries));

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
