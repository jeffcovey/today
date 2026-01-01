#!/usr/bin/env node

/**
 * markdown-diary plugin
 *
 * Reads diary entries from vault/diary/*.md files.
 * Each daily file (YYYY-MM-DD.md) contains sections:
 * - Gratitude: Simple bullets (no timestamps)
 * - Progress: ### HH:MM blocks (timestamped, multi-paragraph)
 * - Concerns: ### HH:MM blocks (timestamped, multi-paragraph)
 * - Journal: ### HH:MM blocks (timestamped, multi-paragraph)
 *
 * Uses vault-changes for efficient incremental sync - only processes
 * diary files that have actually changed.
 */

import fs from 'fs';
import path from 'path';
import { getChangedFilePaths, getBaselineStatus } from '../../src/vault-changes.js';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const lastSyncTime = process.env.LAST_SYNC_TIME || '';

const diaryDirectory = config.diary_directory || 'vault/diary';
const diaryDir = path.join(projectRoot, diaryDirectory);

// Parse last sync time for incremental sync
const lastSyncDate = lastSyncTime ? new Date(lastSyncTime) : null;

/**
 * Get today's date in YYYY-MM-DD format (respecting configured timezone)
 */
function getTodayDateString() {
  const tz = process.env.TZ || 'America/New_York';
  const now = new Date();
  return now.toLocaleDateString('en-CA', { timeZone: tz }); // en-CA gives YYYY-MM-DD format
}

/**
 * Create today's diary file if it doesn't exist
 * Returns true if file was created, false if it already existed
 */
function ensureTodaysDiaryFile() {
  const today = getTodayDateString();
  const filePath = path.join(diaryDir, `${today}.md`);

  if (fs.existsSync(filePath)) {
    return false;
  }

  // Create minimal front matter template
  const content = `---
date: ${today}
---

`;

  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

/**
 * Check if a diary file only contains the auto-generated template (no real content)
 */
function isEmptyDiaryFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const { body } = parseFrontMatter(content);

    // File is "empty" if body is whitespace-only (no sections, no entries)
    return body.trim() === '';
  } catch {
    return false;
  }
}

/**
 * Clean up empty diary files from previous days
 * Only removes files that contain just the auto-generated template
 */
function cleanupEmptyDiaryFiles() {
  const today = getTodayDateString();
  const removed = [];

  if (!fs.existsSync(diaryDir)) {
    return removed;
  }

  const files = fs.readdirSync(diaryDir)
    .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f));

  for (const file of files) {
    const fileDate = file.replace('.md', '');

    // Skip today's file - never remove it
    if (fileDate === today) continue;

    const filePath = path.join(diaryDir, file);

    if (isEmptyDiaryFile(filePath)) {
      try {
        fs.unlinkSync(filePath);
        removed.push(file);
      } catch {
        // Ignore removal errors
      }
    }
  }

  return removed;
}

/**
 * Parse YAML front matter from markdown
 */
function parseFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return { frontMatter: {}, body: content };
  }

  const yaml = match[1];
  const body = content.slice(match[0].length).trim();

  // Simple YAML parser
  const frontMatter = {};
  for (const line of yaml.split('\n')) {
    const keyMatch = line.match(/^(\w+):\s*(.*)$/);
    if (keyMatch) {
      frontMatter[keyMatch[1]] = keyMatch[2].trim();
    }
  }

  return { frontMatter, body };
}

/**
 * Parse sections from markdown body
 * Returns { gratitude: [...], progress: [...], concerns: [...], journal: [...] }
 */
function parseSections(body, fileDate) {
  const sections = {
    gratitude: [],
    progress: [],
    concern: [],
    journal: []
  };

  // Split by ## headers
  const sectionRegex = /^## (I'm grateful for(?:\.\.\.)?|Gratitude|Progress|Concerns?|Journal)\s*$/gim;
  const sectionMatches = [...body.matchAll(sectionRegex)];

  for (let i = 0; i < sectionMatches.length; i++) {
    const match = sectionMatches[i];
    // Normalize section name: concerns -> concern, "i'm grateful for..." -> gratitude
    let sectionName = match[1].toLowerCase();
    if (sectionName === 'concerns') sectionName = 'concern';
    if (sectionName.startsWith("i'm grateful for")) sectionName = 'gratitude';
    const startIndex = match.index + match[0].length;
    const endIndex = sectionMatches[i + 1]?.index || body.length;
    const sectionContent = body.slice(startIndex, endIndex).trim();

    if (sectionName === 'gratitude') {
      // Parse as simple bullets (no timestamps)
      const entries = parseGratitudeSection(sectionContent, fileDate);
      sections.gratitude.push(...entries);
    } else {
      // Parse as timestamped blocks (### HH:MM)
      const entries = parseTimestampedSection(sectionContent, fileDate, sectionName);
      sections[sectionName]?.push(...entries);
    }
  }

  return sections;
}

/**
 * Parse gratitude section - simple bullets without timestamps
 */
function parseGratitudeSection(content, fileDate) {
  const entries = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const bulletMatch = line.match(/^-\s+(.+)$/);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      if (text) {
        entries.push({
          date: `${fileDate}T00:00:00`,
          text: `I'm grateful for ${text}`
        });
      }
    }
  }

  return entries;
}

/**
 * Parse timestamped section - ### HH:MM blocks with multi-paragraph content
 */
function parseTimestampedSection(content, fileDate, sectionType) {
  const entries = [];

  // Split by ### HH:MM headers
  const timeRegex = /^### (\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/gm;
  const timeMatches = [...content.matchAll(timeRegex)];

  if (timeMatches.length === 0) {
    // No timestamps - treat entire content as single entry at midnight
    const text = content.trim();
    if (text) {
      entries.push({
        date: `${fileDate}T00:00:00`,
        text: text
      });
    }
    return entries;
  }

  for (let i = 0; i < timeMatches.length; i++) {
    const match = timeMatches[i];
    const hour = match[1].padStart(2, '0');
    const minute = match[2];
    const second = match[3] || '00';
    const time = `${hour}:${minute}:${second}`;

    const startIndex = match.index + match[0].length;
    const endIndex = timeMatches[i + 1]?.index || content.length;
    const text = content.slice(startIndex, endIndex).trim();

    if (text) {
      entries.push({
        date: `${fileDate}T${time}`,
        text: text
      });
    }
  }

  return entries;
}

/**
 * Process a single diary file
 */
function processDiaryFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const { frontMatter, body } = parseFrontMatter(content);

  // Get date from front matter or filename
  const filename = path.basename(filePath, '.md');
  const fileDate = frontMatter.date || filename;

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fileDate)) {
    return { entries: [], error: `Invalid date in ${filename}` };
  }

  const sections = parseSections(body, fileDate);
  const entries = [];

  // Convert sections to diary entries
  for (const [type, items] of Object.entries(sections)) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      entries.push({
        id: `markdown-diary:${fileDate}-${type}-${i + 1}`,
        date: item.date,
        text: item.text,
        metadata: JSON.stringify({ type: type })
      });
    }
  }

  return { entries, error: null };
}

// Main
const entries = [];
const errors = [];
const processed = [];
let isIncremental = false;
let createdTodaysFile = false;
let removedEmptyFiles = [];

// Create diary directory if it doesn't exist
if (!fs.existsSync(diaryDir)) {
  fs.mkdirSync(diaryDir, { recursive: true });
}

// Clean up empty diary files from previous days
removedEmptyFiles = cleanupEmptyDiaryFiles();

// Ensure today's diary file exists
createdTodaysFile = ensureTodaysDiaryFile();

// Get list of diary files to process
let diaryFiles = [];

if (lastSyncDate) {
  // Use vault-changes for efficient incremental sync
  const baselineStatus = getBaselineStatus();
  if (baselineStatus.exists) {
    // Get changed files from vault-changes
    const changedFiles = getChangedFilePaths({
      directory: diaryDir,
      todayOnly: true,
      includeGit: false
    });
    // Filter to only diary files (YYYY-MM-DD.md pattern)
    diaryFiles = changedFiles.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(path.basename(f)));
    isIncremental = true;
  } else {
    // No baseline yet - process all diary files modified since last sync
    diaryFiles = fs.existsSync(diaryDir)
      ? fs.readdirSync(diaryDir)
          .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
          .map(f => path.join(diaryDir, f))
          .filter(f => {
            const stats = fs.statSync(f);
            return stats.mtime > lastSyncDate;
          })
      : [];
    isIncremental = true;
  }
} else {
  // Full sync - process all diary files
  diaryFiles = fs.existsSync(diaryDir)
    ? fs.readdirSync(diaryDir)
        .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .map(f => path.join(diaryDir, f))
    : [];
}

for (const file of diaryFiles) {
  try {
    const result = processDiaryFile(file);
    entries.push(...result.entries);
    processed.push({
      file: path.basename(file),
      entries: result.entries.length
    });
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
  incremental: isIncremental,
  metadata: {
    diary_files: diaryFiles.length,
    entries_count: entries.length,
    processed: processed.length > 0 ? processed : undefined,
    created_today: createdTodaysFile ? getTodayDateString() + '.md' : undefined,
    removed_empty: removedEmptyFiles.length > 0 ? removedEmptyFiles : undefined,
    errors: errors.length > 0 ? errors : undefined
  }
}));
