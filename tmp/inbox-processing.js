#!/usr/bin/env node

/**
 * Inbox Processing
 *
 * NOTE: This was extracted from bin/sync for migration to a standalone script.
 *
 * Functions:
 * - processInbox: Process all files in vault/notes/inbox
 * - processInboxFile: Route a single inbox file
 * - processProgressNote: Handle progress notes -> plan files
 * - processConcernNote: Handle concern notes -> plan files
 * - processTaskOnlyFile: Handle task-only files -> tasks.md
 * - moveToTrash: Move files to dated trash folder
 *
 * CLI commands this supported:
 * - bin/sync --process-inbox-only
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  formatDate,
  getWeekNumber,
  getQuarterNumber,
} from '../src/date-utils.js';
import {
  printStatus,
  printError,
  printInfo,
  printWarning,
  printHeader,
} from '../src/cli-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

process.chdir(projectRoot);

/**
 * Process all files in inbox
 */
async function processInbox() {
  printInfo('Processing inbox files...');

  const inboxDir = path.join(projectRoot, 'vault/inbox');

  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  try {
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));

    if (files.length === 0) {
      printInfo('No files in inbox to process');
      return true;
    }

    printInfo(`Processing ${files.length} file(s) from inbox...`);

    // First pass: process non-time-tracking files
    for (const filename of files) {
      const filePath = path.join(inboxDir, filename);
      const result = await processInboxFile(filePath);

      // Skip time tracking markers in individual processing
      if (result === 'time-tracking') {
        continue;
      }
    }

    // Second pass: batch process all time tracking markers
    try {
      processTimeTrackingMarkers();
    } catch (error) {
      printError(`Time tracking processing failed: ${error.message}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
    }

    return true;
  } catch (error) {
    printError(`Inbox processing failed: ${error.message}`);
    return false;
  }
}

/**
 * Route a single inbox file based on content
 */
async function processInboxFile(filePath) {
  const content = safeReadFile(filePath);
  if (!content) return 'skipped'; // File was locked, skip it

  const lines = content.split('\n');
  const firstLine = lines[0] || '';
  const title = firstLine.replace(/^#\s*/, '').replace(/^-\s*\[\s*\]\s*/, '');
  const basename = path.basename(filePath);

  // Time tracking markers
  if (basename.startsWith('time-tracking-')) {
    return processTimeTrackingMarker(filePath, content, basename);
  }

  // Progress notes
  if (title === 'Progress') {
    return processProgressNote(filePath, content, basename);
  }

  // Concern notes
  if (title === 'Concerns' || basename.includes('concerns')) {
    return processConcernNote(filePath, content, basename);
  }

  // Task files (only checkboxes)
  if (/^-\s*\[[x ]\]/m.test(content)) {
    const taskOnly = lines.every(line =>
      !line.trim() || /^-\s*\[[x ]\]/.test(line)
    );

    if (taskOnly) {
      return processTaskOnlyFile(filePath, content);
    }
  }

  // Default: move to general notes
  const destDir = path.join(projectRoot, 'vault/notes/general');
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, basename);

  if (fs.existsSync(destPath)) {
    moveToTrash(filePath);
    printInfo(`  • Duplicate file moved to trash: ${basename}`);
  } else {
    fs.renameSync(filePath, destPath);
    printInfo(`  • Note → notes/general/${basename}`);
  }
}

/**
 * Process a progress note - add to plan file and archive
 */
function processProgressNote(filePath, content, basename) {
  // Content is already safely read by caller
  const dateMatch = content.match(/^[A-Za-z]+ \d+, \d+ \d+:\d+/m);

  if (!dateMatch) {
    printWarning(`  • Progress note missing date, leaving in inbox: ${basename}`);
    return;
  }

  const dateStr = dateMatch[0];
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const week = String(getWeekNumber(date)).padStart(2, '0');
  const quarter = getQuarterNumber(date);

  const planFile = `vault/plans/${year}_Q${quarter}_${month}_W${week}_${day}.md`;

  if (!fs.existsSync(planFile)) {
    printWarning(`  • No plan file for ${year}-${month}-${day}`);
    printWarning(`  • Leaving in inbox - will be filed when plan file is created`);
    return;
  }

  const cleanedLines = content.split('\n').slice(1).filter((line, i) => {
    return i > 0 || line.trim();
  });
  const cleanedContent = cleanedLines.join('\n');

  const timestamp = dateStr.match(/\d+:\d+/)?.[0] || 'Unknown';

  const calloutContent = cleanedContent
    .split('\n')
    .map(line => line ? '> ' + line : '>')
    .join('\n');

  fs.appendFileSync(planFile, `\n<!-- PROGRESS_UPDATE -->\n> [!success] 📊 Progress Update (${timestamp})\n>\n${calloutContent}\n<!-- /PROGRESS_UPDATE -->\n`);

  printInfo(`  • Progress note → Added to ${path.basename(planFile)}`);

  const destDir = path.join(projectRoot, 'vault/notes/progress');
  fs.mkdirSync(destDir, { recursive: true });

  const time = dateStr.match(/\d+:\d+/)?.[0].replace(':', '') || '0000';
  const destFile = `${year}-${month}-${day}-${time}00-UTC-progress.md`;
  const destPath = path.join(destDir, destFile);

  fs.writeFileSync(destPath, cleanedContent, 'utf-8');
  fs.unlinkSync(filePath);

  printInfo(`  • Filed to progress/${destFile}`);
}

/**
 * Process a concern note - add to plan file and archive
 */
function processConcernNote(filePath, content, basename) {
  // Content is already safely read by caller
  const dateMatch = content.match(/^[A-Za-z]+ \d+, \d+ \d+:\d+/m);

  if (!dateMatch) {
    printWarning(`  • Concern note missing date, leaving in inbox: ${basename}`);
    return;
  }

  const dateStr = dateMatch[0];
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const week = String(getWeekNumber(date)).padStart(2, '0');
  const quarter = getQuarterNumber(date);

  const planFile = `vault/plans/${year}_Q${quarter}_${month}_W${week}_${day}.md`;

  if (!fs.existsSync(planFile)) {
    printWarning(`  • No plan file for ${year}-${month}-${day}`);
    printWarning(`  • Leaving in inbox - will be filed when plan file is created`);
    return;
  }

  const cleanedLines = content.split('\n').slice(1).filter((line, i) => {
    return i > 0 || line.trim();
  });
  const cleanedContent = cleanedLines.join('\n');

  const timestamp = dateStr.match(/\d+:\d+/)?.[0] || 'Unknown';

  const calloutContent = cleanedContent
    .split('\n')
    .map(line => line ? '> ' + line : '>')
    .join('\n');

  fs.appendFileSync(planFile, `\n<!-- CONCERN -->\n> [!warning] ⚠️ Concerns (${timestamp})\n>\n${calloutContent}\n<!-- /CONCERN -->\n`);

  printInfo(`  • Concern note → Added to ${path.basename(planFile)}`);

  const destDir = path.join(projectRoot, 'vault/notes/concerns');
  fs.mkdirSync(destDir, { recursive: true });

  const time = dateStr.match(/\d+:\d+/)?.[0].replace(':', '') || '0000';
  const destFile = `${year}-${month}-${day}-${time}00-UTC-concerns.md`;
  const destPath = path.join(destDir, destFile);

  fs.writeFileSync(destPath, cleanedContent, 'utf-8');
  fs.unlinkSync(filePath);

  printInfo(`  • Filed to concerns/${destFile}`);
}

/**
 * Process a task-only file - append to tasks.md
 */
function processTaskOnlyFile(filePath, content) {
  const tasksFile = path.join(projectRoot, 'vault/tasks/tasks.md');

  if (fs.existsSync(tasksFile)) {
    const existing = fs.readFileSync(tasksFile, 'utf-8');
    if (existing.includes('# Archive')) {
      const parts = existing.split('# Archive');
      fs.writeFileSync(tasksFile, `${parts[0].trimEnd()}\n\n${content}\n\n# Archive${parts[1] || ''}`, 'utf-8');
    } else {
      fs.appendFileSync(tasksFile, `\n${content}\n`);
    }
  } else {
    fs.writeFileSync(tasksFile, content, 'utf-8');
  }

  const taskCount = (content.match(/^-\s*\[[x ]\]/gm) || []).length;
  printInfo(`  • Task-only file → Added ${taskCount} task(s) to tasks.md`);

  moveToTrash(filePath);
}

/**
 * Process time tracking markers
 */
function processTimeTrackingMarker(filePath, content, basename) {
  // Mark this file for batch processing - we'll handle all markers together
  return 'time-tracking';
}

/**
 * Process all time tracking markers in batch
 */
function processTimeTrackingMarkers() {
  const inboxDir = path.join(projectRoot, 'vault/inbox');
  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
  const markers = [];


  // Collect all time tracking markers
  for (const filename of files) {
    if (filename.startsWith('time-tracking-')) {
      const filePath = path.join(inboxDir, filename);
      const content = safeReadFile(filePath);

      if (!content) {
        printWarning(`  • Skipping locked time tracking file: ${filename}`);
        continue;
      }

      const lines = content.trim().split('\n');

      const action = lines[0];
      const timestamp = lines[1];
      const description = lines[2] || '';

      markers.push({
        filePath,
        action,
        timestamp,
        description,
        parsedTime: new Date(timestamp)
      });
    }
  }

  if (markers.length === 0) return;

  printInfo(`Processing ${markers.length} time tracking marker(s)...`);

  // Sort by timestamp
  markers.sort((a, b) => a.parsedTime - b.parsedTime);

  // First, collapse duplicate markers (same action within 30 seconds)
  const collapsedMarkers = [];

  for (const marker of markers) {
    const existingSameAction = collapsedMarkers.filter(m =>
      m.action === marker.action &&
      Math.abs(m.parsedTime - marker.parsedTime) / 1000 <= 30
    );

    if (existingSameAction.length > 0) {
      // Update existing marker with earliest start or latest stop
      const existing = existingSameAction[0];
      if (marker.action === 'Start' && marker.parsedTime < existing.parsedTime) {
        existing.timestamp = marker.timestamp;
        existing.parsedTime = marker.parsedTime;
      } else if (marker.action === 'Stop' && marker.parsedTime > existing.parsedTime) {
        existing.timestamp = marker.timestamp;
        existing.parsedTime = marker.parsedTime;
      }
    } else {
      collapsedMarkers.push({ ...marker });
    }
  }

  // Sort collapsed markers by timestamp
  collapsedMarkers.sort((a, b) => a.parsedTime - b.parsedTime);

  // Now pair starts and stops chronologically
  const sessions = [];
  const startStack = [];

  for (const marker of collapsedMarkers) {
    if (marker.action === 'Start') {
      startStack.push(marker);
    } else if (marker.action === 'Stop' && startStack.length > 0) {
      const startMarker = startStack.pop();

      // Map description to topic tag
      const topicTag = mapDescriptionToTopic(startMarker.description);

      sessions.push({
        startTime: startMarker.timestamp,
        endTime: marker.timestamp,
        description: startMarker.description,
        topicTag: topicTag
      });
    }
  }

  // Add sessions to time tracking log
  if (sessions.length > 0) {
    addSessionsToTimeLog(sessions);
  }

  // Archive all processed marker files
  for (const marker of markers) {
    moveToTrash(marker.filePath);
  }

  printInfo(`  • Created ${sessions.length} time tracking session(s)`);
}

/**
 * Map focus mode description to topic tag
 */
function mapDescriptionToTopic(description) {
  const mapping = {
    'Mindfulness': '#topic/meditation_mindfulness',
    'Exercise': '#topic/fitness',
    'Work': '#topic/programming',
    'Reading': '#topic/reading'
  };

  return mapping[description] || '#topic/other';
}

/**
 * Add sessions to time tracking log and sort
 */
function addSessionsToTimeLog(sessions) {
  for (const session of sessions) {
    const date = new Date(session.startTime);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    const logFile = path.join(projectRoot, `vault/logs/time-tracking/${year}-${month}.md`);

    // Ensure directory exists
    const logDir = path.dirname(logFile);
    fs.mkdirSync(logDir, { recursive: true });

    // Format new entry
    const entry = `${session.startTime}|${session.endTime}|${session.description} ${session.topicTag}`;

    // Read existing content or create new
    let content = '';
    if (fs.existsSync(logFile)) {
      content = fs.readFileSync(logFile, 'utf-8');
    }

    // Add new entry
    content += content ? `\n${entry}` : entry;

    // Sort entries by start time
    const entries = content.trim().split('\n').filter(line => line.trim());
    entries.sort((a, b) => {
      const timeA = a.split('|')[0];
      const timeB = b.split('|')[0];
      return new Date(timeA) - new Date(timeB);
    });

    // Write sorted content back
    fs.writeFileSync(logFile, entries.join('\n') + '\n', 'utf-8');
  }
}

/**
 * Safely read a file with retry logic for locked files
 */
function safeReadFile(filePath, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if (error.code === 'EDEADLK' || error.message.includes('Resource deadlock')) {
        printInfo(`  • File locked (attempt ${attempt}/${maxRetries}): ${path.basename(filePath)}`);
        if (attempt < maxRetries) {
          // Wait a bit before retrying
          const delay = attempt * 1000; // 1s, 2s, 3s
          const start = Date.now();
          while (Date.now() - start < delay) {
            // Simple busy wait
          }
          continue;
        } else {
          printWarning(`  • Skipping locked file: ${path.basename(filePath)}`);
          return null;
        }
      }
      throw error; // Re-throw other errors
    }
  }
  return null;
}

/**
 * Move file to dated trash folder
 */
function moveToTrash(filePath) {
  const todayStr = formatDate(new Date());
  const trashDir = path.join(projectRoot, 'vault/notes/.trash', todayStr);
  fs.mkdirSync(trashDir, { recursive: true });

  const basename = path.basename(filePath);
  const trashPath = path.join(trashDir, `${todayStr}-${basename}`);

  fs.renameSync(filePath, trashPath);
}

// CLI
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'process':
  case undefined:
    printHeader('📥 Process Inbox');
    processInbox()
      .then(() => {
        printStatus('Inbox processed successfully!');
        process.exit(0);
      })
      .catch((error) => {
        printError(`Inbox processing failed: ${error.message}`);
        process.exit(1);
      });
    break;

  case 'help':
  case '--help':
    console.log(`Inbox Processing - Extract from bin/sync

Usage:
  inbox-processing [process]    Process all inbox files (default)
  inbox-processing help         Show this help

Processes files in vault/notes/inbox:
  - Time tracking markers → Group, create sessions, add to time logs
  - Progress notes → Add to plan file, archive to progress/
  - Concern notes → Add to plan file, archive to concerns/
  - Task-only files → Append to tasks.md
  - Other notes → Move to notes/general/
`);
    break;

  default:
    printError(`Unknown command: ${command}`);
    process.exit(1);
}

export { processInbox };
