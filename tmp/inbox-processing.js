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

  const inboxDir = path.join(projectRoot, 'vault/notes/inbox');

  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  try {
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));

    if (files.length === 0) {
      printInfo('No files in inbox to process');
      return true;
    }

    printInfo(`Processing ${files.length} file(s) from inbox...`);

    for (const filename of files) {
      const filePath = path.join(inboxDir, filename);
      await processInboxFile(filePath);
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
  const content = fs.readFileSync(filePath, 'utf-8');
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
