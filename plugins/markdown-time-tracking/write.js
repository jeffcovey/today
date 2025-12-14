#!/usr/bin/env node

// Write a time entry to markdown files
// Moved from bin/track - this is the markdown-specific file writing logic
//
// Input: ENTRY_JSON environment variable with entry data
// Output: JSON with success status

import fs from 'fs';
import path from 'path';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const entryJson = process.env.ENTRY_JSON || '';
const directory = config.directory || 'vault/logs/time-tracking';

const timeDir = path.join(projectRoot, directory);
const currentTimerFile = path.join(timeDir, 'current-timer.md');

// Ensure directory exists
if (!fs.existsSync(timeDir)) {
  fs.mkdirSync(timeDir, { recursive: true });
}

// Parse entry
let entry;
try {
  entry = JSON.parse(entryJson);
} catch (error) {
  console.log(JSON.stringify({ success: false, error: `Invalid ENTRY_JSON: ${error.message}` }));
  process.exit(1);
}

// Validate required fields
if (!entry.start_time) {
  console.log(JSON.stringify({ success: false, error: 'Missing required field: start_time' }));
  process.exit(1);
}
if (!entry.description) {
  console.log(JSON.stringify({ success: false, error: 'Missing required field: description' }));
  process.exit(1);
}

// Get month file path from start_time
function getMonthFile(startTime) {
  const date = new Date(startTime);
  const yearMonth = date.toISOString().substring(0, 7); // YYYY-MM
  return path.join(timeDir, `${yearMonth}.md`);
}

try {
  if (!entry.end_time) {
    // START TIMER: Write to current-timer.md
    // Format: description on line 1, start_time on line 2
    fs.writeFileSync(currentTimerFile, `${entry.description}\n${entry.start_time}`);

    console.log(JSON.stringify({
      success: true,
      action: 'start',
      file: currentTimerFile,
      entry: {
        start_time: entry.start_time,
        end_time: null,
        description: entry.description
      }
    }));
  } else {
    // COMPLETE ENTRY: Append to month file and clear current-timer
    const monthFile = getMonthFile(entry.start_time);
    const line = `${entry.start_time}|${entry.end_time}|${entry.description}\n`;

    fs.appendFileSync(monthFile, line);

    // Clear current-timer.md (keep file but empty for Apple Shortcuts compatibility)
    fs.writeFileSync(currentTimerFile, '');

    console.log(JSON.stringify({
      success: true,
      action: 'complete',
      file: monthFile,
      entry: {
        start_time: entry.start_time,
        end_time: entry.end_time,
        description: entry.description
      }
    }));
  }
} catch (error) {
  console.log(JSON.stringify({ success: false, error: `Failed to write: ${error.message}` }));
  process.exit(1);
}
