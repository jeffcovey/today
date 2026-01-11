#!/usr/bin/env node

/**
 * Inbox Processing Plugin
 *
 * Processes files in the inbox directory and routes them:
 * - Progress notes → diary file
 * - Concern notes → diary file
 * - Task-only files → tasks.md
 * - Unrecognized files → left in inbox for user review
 *
 * Processed files are moved to .trash and cleaned up after retention period.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { format } from 'date-fns';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Read settings from environment (set by plugin loader)
const inboxDirectory = process.env.PLUGIN_SETTING_INBOX_DIRECTORY || `${process.env.VAULT_PATH}/inbox`;
const diaryDirectory = process.env.PLUGIN_SETTING_DIARY_DIRECTORY || `${process.env.VAULT_PATH}/diary`;
const tasksFile = process.env.PLUGIN_SETTING_TASKS_FILE || `${process.env.VAULT_PATH}/tasks/tasks.md`;
const trashRetentionDays = parseInt(process.env.PLUGIN_SETTING_TRASH_RETENTION_DAYS || '7', 10);

// Resolve paths relative to project root
const inboxDir = path.join(PROJECT_ROOT, inboxDirectory);
const diaryDir = path.join(PROJECT_ROOT, diaryDirectory);
const tasksPath = path.join(PROJECT_ROOT, tasksFile);
const trashDir = path.join(inboxDir, '.trash');

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate() {
  return format(new Date(), 'yyyy-MM-dd');
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
        if (attempt < maxRetries) {
          // Wait a bit before retrying
          const delay = attempt * 1000; // 1s, 2s, 3s
          const start = Date.now();
          while (Date.now() - start < delay) {
            // Simple busy wait
          }
          continue;
        } else {
          return null; // Skip locked files
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
  const todayStr = getTodayDate();
  const todayTrashDir = path.join(trashDir, todayStr);
  fs.mkdirSync(todayTrashDir, { recursive: true });

  const basename = path.basename(filePath);
  const trashPath = path.join(todayTrashDir, basename);

  fs.renameSync(filePath, trashPath);
}

/**
 * Clean up old trash folders beyond retention period
 */
function cleanupTrash() {
  if (!fs.existsSync(trashDir)) {
    return { deleted: 0 };
  }

  const now = new Date();
  const cutoffMs = trashRetentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  const entries = fs.readdirSync(trashDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Parse date from folder name (YYYY-MM-DD)
    const folderDate = new Date(entry.name);
    if (isNaN(folderDate.getTime())) continue;

    const ageMs = now.getTime() - folderDate.getTime();
    if (ageMs > cutoffMs) {
      const folderPath = path.join(trashDir, entry.name);
      // Delete folder and contents
      fs.rmSync(folderPath, { recursive: true, force: true });
      deleted++;
    }
  }

  return { deleted };
}

/**
 * Parse date from note content (e.g., "December 17, 2025 14:30" or "December 17, 2025")
 */
function parseDateFromContent(content) {
  // Try with time first
  let dateMatch = content.match(/^([A-Za-z]+ \d+, \d+)(?: (\d+:\d+))?/m);
  if (!dateMatch) return null;

  const dateStr = dateMatch[1];
  const timeStr = dateMatch[2] || null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;

  return {
    date,
    dateStr,
    timestamp: timeStr,
    formatted: format(date, 'yyyy-MM-dd')
  };
}

/**
 * Get or create diary file for a specific date
 */
function getDiaryFile(dateStr) {
  const filePath = path.join(diaryDir, `${dateStr}.md`);

  if (!fs.existsSync(diaryDir)) {
    fs.mkdirSync(diaryDir, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    // Create new diary file with front matter
    const content = `---
date: ${dateStr}
---

`;
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  return filePath;
}

/**
 * Apply a modification to a section in a diary file.
 * Re-reads the file immediately before writing to minimize race conditions
 * when multiple processes (e.g., local + remote deployments) may be syncing.
 */
function modifyDiarySection(filePath, sectionName, modifyFn) {
  // Re-read file immediately before modification to get freshest content
  let fileContent = fs.readFileSync(filePath, 'utf-8');

  const sectionHeader = `## ${sectionName}`;

  // Add section if it doesn't exist
  if (!fileContent.includes(sectionHeader)) {
    fileContent = fileContent.trimEnd() + `\n\n${sectionHeader}\n`;
  }

  // Find the section boundaries
  const insertPoint = fileContent.indexOf(sectionHeader) + sectionHeader.length;
  const beforeSection = fileContent.slice(0, insertPoint);
  const afterSection = fileContent.slice(insertPoint);

  // Find the end of the section (next ## or end of file)
  const nextSectionMatch = afterSection.match(/\n## /);
  const sectionEnd = nextSectionMatch ? nextSectionMatch.index : afterSection.length;

  const sectionContent = afterSection.slice(0, sectionEnd);
  const restContent = afterSection.slice(sectionEnd);

  // Apply the modification
  const newSectionContent = modifyFn(sectionContent);
  fileContent = beforeSection + newSectionContent + restContent;

  // Write immediately after read-modify
  fs.writeFileSync(filePath, fileContent, 'utf-8');
}

/**
 * Add entry to diary file under a specific section
 */
function addToDiary(dateStr, sectionName, timestamp, content) {
  const filePath = getDiaryFile(dateStr);
  const newEntry = `\n\n### ${timestamp}\n${content}`;

  modifyDiarySection(filePath, sectionName, (sectionContent) => {
    return sectionContent.trimEnd() + newEntry + '\n';
  });

  return filePath;
}

/**
 * Add bullet items to diary file under a specific section (no timestamps)
 */
function addBulletsToDiary(dateStr, sectionName, bullets) {
  const filePath = getDiaryFile(dateStr);
  const bulletText = bullets.map(b => `- ${b}`).join('\n');

  modifyDiarySection(filePath, sectionName, (sectionContent) => {
    return sectionContent.trimEnd() + '\n' + bulletText + '\n';
  });

  return filePath;
}

/**
 * Process a gratitude note - add bullets to diary file
 */
function processGratitudeNote(filePath, content, basename) {
  const parsed = parseDateFromContent(content);

  if (!parsed) {
    return { action: 'skipped', reason: 'missing date', file: basename };
  }

  // Extract gratitude items - look for content after "I'm grateful for..."
  const lines = content.split('\n');
  const bullets = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip header, date line, and "I'm grateful for..." prompt
    if (trimmed.startsWith('#') ||
        trimmed.match(/^[A-Za-z]+ \d+, \d+/) ||
        trimmed.toLowerCase().includes("i'm grateful for") ||
        !trimmed) {
      continue;
    }
    bullets.push(trimmed);
  }

  if (bullets.length === 0) {
    return { action: 'skipped', reason: 'no gratitude items found', file: basename };
  }

  // Add to diary under "I'm grateful for..." section
  const diaryFile = addBulletsToDiary(parsed.formatted, "I'm grateful for...", bullets);

  // Move to trash
  moveToTrash(filePath);

  return {
    action: 'processed',
    type: 'gratitude',
    items: bullets.length,
    destination: path.basename(diaryFile),
    file: basename
  };
}

/**
 * Process a progress note - add to diary file
 */
function processProgressNote(filePath, content, basename) {
  const parsed = parseDateFromContent(content);

  if (!parsed) {
    return { action: 'skipped', reason: 'missing date', file: basename };
  }

  // Extract content (skip title line and date line)
  const lines = content.split('\n');
  const cleanedLines = lines.slice(1).filter(line => {
    // Skip the date line and empty lines at the start
    return !line.match(/^[A-Za-z]+ \d+, \d+ \d+:\d+/) && line.trim();
  });
  const cleanedContent = cleanedLines.join('\n').trim();

  // Add to diary
  const diaryFile = addToDiary(parsed.formatted, 'Progress', parsed.timestamp, cleanedContent);

  // Move to trash
  moveToTrash(filePath);

  return {
    action: 'processed',
    type: 'progress',
    destination: path.basename(diaryFile),
    file: basename
  };
}

/**
 * Process a concern note - add to diary file
 */
function processConcernNote(filePath, content, basename) {
  const parsed = parseDateFromContent(content);

  if (!parsed) {
    return { action: 'skipped', reason: 'missing date', file: basename };
  }

  // Extract content (skip title line and date line)
  const lines = content.split('\n');
  const cleanedLines = lines.slice(1).filter(line => {
    // Skip the date line and empty lines at the start
    return !line.match(/^[A-Za-z]+ \d+, \d+ \d+:\d+/) && line.trim();
  });
  const cleanedContent = cleanedLines.join('\n').trim();

  // Add to diary
  const diaryFile = addToDiary(parsed.formatted, 'Concern', parsed.timestamp, cleanedContent);

  // Move to trash
  moveToTrash(filePath);

  return {
    action: 'processed',
    type: 'concern',
    destination: path.basename(diaryFile),
    file: basename
  };
}

/**
 * Process a task-only file - append to tasks.md
 */
function processTaskOnlyFile(filePath, content, basename) {
  // Ensure tasks directory exists
  const tasksDir = path.dirname(tasksPath);
  if (!fs.existsSync(tasksDir)) {
    fs.mkdirSync(tasksDir, { recursive: true });
  }

  if (fs.existsSync(tasksPath)) {
    const existing = fs.readFileSync(tasksPath, 'utf-8');
    if (existing.includes('# Archive')) {
      const parts = existing.split('# Archive');
      fs.writeFileSync(tasksPath, `${parts[0].trimEnd()}\n\n${content}\n\n# Archive${parts[1] || ''}`, 'utf-8');
    } else {
      fs.appendFileSync(tasksPath, `\n${content}\n`);
    }
  } else {
    fs.writeFileSync(tasksPath, content, 'utf-8');
  }

  const taskCount = (content.match(/^-\s*\[[x ]\]/gm) || []).length;

  // Move to trash
  moveToTrash(filePath);

  return {
    action: 'processed',
    type: 'tasks',
    taskCount,
    file: basename
  };
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

    const logFile = path.join(PROJECT_ROOT, `vault/logs/time-tracking/${year}-${month}.md`);

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
 * Process time tracking markers - collect, collapse duplicates, create sessions
 */
function processTimeTrackingMarkers(files) {
  const markers = [];

  // Collect all time tracking markers
  for (const filename of files) {
    if (filename.startsWith('time-tracking-')) {
      const filePath = path.join(inboxDir, filename);

      const content = safeReadFile(filePath);

      if (!content) {
        continue; // Skip locked files
      }

      try {
        const lines = content.trim().split('\n');

        const action = lines[0];
        const timestamp = lines[1];
        const description = lines[2] || '';

        const parsedTime = new Date(timestamp);
        if (isNaN(parsedTime.getTime())) {
          continue; // Skip invalid timestamps
        }

        markers.push({
          filePath,
          action,
          timestamp,
          description,
          parsedTime
        });
      } catch (error) {
        continue; // Skip problematic files
      }
    }
  }

  if (markers.length === 0) {
    return { processed: 0, sessions: 0 };
  }

  // Sort by timestamp
  markers.sort((a, b) => a.parsedTime - b.parsedTime);

  // Collapse duplicate markers (same action within 30 seconds)
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

  // Pair starts and stops chronologically
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

  return {
    processed: markers.length,
    sessions: sessions.length
  };
}

/**
 * Route a single inbox file based on content
 */
function processInboxFile(filePath) {
  const content = safeReadFile(filePath);

  if (!content) {
    // File is locked, skip it
    return { action: 'skipped', reason: 'file locked', file: path.basename(filePath) };
  }

  const lines = content.split('\n');
  const firstLine = lines[0] || '';
  const title = firstLine.replace(/^#\s*/, '').replace(/^-\s*\[\s*\]\s*/, '');
  const basename = path.basename(filePath);

  // Progress notes
  if (title === 'Progress') {
    return processProgressNote(filePath, content, basename);
  }

  // Concern notes
  if (title === 'Concerns' || basename.includes('concerns')) {
    return processConcernNote(filePath, content, basename);
  }

  // Gratitude notes
  if (title === 'Gratitude' || basename.includes('gratitude')) {
    return processGratitudeNote(filePath, content, basename);
  }

  // Task files (only checkboxes)
  if (/^-\s*\[[x ]\]/m.test(content)) {
    const taskOnly = lines.every(line =>
      !line.trim() || /^-\s*\[[x ]\]/.test(line)
    );

    if (taskOnly) {
      return processTaskOnlyFile(filePath, content, basename);
    }
  }

  // Unrecognized: leave in inbox for user review
  return { action: 'unrecognized', file: basename };
}

/**
 * Process all files in inbox
 */
function processInbox() {
  // Ensure inbox directory exists
  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
    return { processed: 0, results: [], message: 'Inbox directory created' };
  }

  // Clean up old trash first
  const trashCleanup = cleanupTrash();

  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));

  if (files.length === 0) {
    let message = 'No files in inbox';
    if (trashCleanup.deleted > 0) {
      message += `, cleaned ${trashCleanup.deleted} old trash folder(s)`;
    }
    return { processed: 0, results: [], trashCleaned: trashCleanup.deleted, message };
  }

  // Process time tracking markers first
  const timeTrackingResult = processTimeTrackingMarkers(files);

  const results = [];

  // Process remaining files (non-time-tracking)
  const nonTimeTrackingFiles = files.filter(f => !f.startsWith('time-tracking-'));

  for (const filename of nonTimeTrackingFiles) {
    const filePath = path.join(inboxDir, filename);
    try {
      const result = processInboxFile(filePath);
      results.push(result);
    } catch (error) {
      results.push({ action: 'error', file: filename, error: error.message });
    }
  }

  const processed = results.filter(r => r.action === 'processed').length + timeTrackingResult.processed;
  const unrecognized = results.filter(r => r.action === 'unrecognized').length;
  const skipped = results.filter(r => r.action === 'skipped').length;
  const errors = results.filter(r => r.action === 'error').length;

  let message = `Processed ${processed}`;
  if (unrecognized) message += `, ${unrecognized} unrecognized`;
  if (skipped) message += `, ${skipped} skipped`;
  if (errors) message += `, ${errors} errors`;
  if (timeTrackingResult.sessions > 0) message += `, ${timeTrackingResult.sessions} time sessions created`;
  if (trashCleanup.deleted > 0) message += `, cleaned ${trashCleanup.deleted} old trash folder(s)`;

  return {
    processed,
    unrecognized,
    skipped,
    errors,
    timeTrackingSessions: timeTrackingResult.sessions,
    trashCleaned: trashCleanup.deleted,
    total: files.length,
    results,
    message
  };
}

// Main execution
const result = processInbox();
console.log(JSON.stringify(result));
