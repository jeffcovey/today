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
 * Supports incremental sync: only processes files modified since LAST_SYNC_TIME
 */

import fs from 'fs';
import path from 'path';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const lastSyncTime = process.env.LAST_SYNC_TIME || '';

const diaryDirectory = config.diary_directory || 'vault/diary';
const diaryDir = path.join(projectRoot, diaryDirectory);

// Parse last sync time for incremental sync
const lastSyncDate = lastSyncTime ? new Date(lastSyncTime) : null;

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
  const sectionRegex = /^## (Gratitude|Progress|Concerns?|Journal)\s*$/gim;
  const sectionMatches = [...body.matchAll(sectionRegex)];

  for (let i = 0; i < sectionMatches.length; i++) {
    const match = sectionMatches[i];
    // Normalize section name: concerns -> concern (but progress stays progress)
    let sectionName = match[1].toLowerCase();
    if (sectionName === 'concerns') sectionName = 'concern';
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
          text: text
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

// Create diary directory if it doesn't exist
if (!fs.existsSync(diaryDir)) {
  fs.mkdirSync(diaryDir, { recursive: true });
}

// Process diary files
const diaryFiles = fs.existsSync(diaryDir)
  ? fs.readdirSync(diaryDir)
      .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(f => path.join(diaryDir, f))
  : [];

for (const file of diaryFiles) {
  try {
    // For incremental sync, skip files not modified since last sync
    if (lastSyncDate) {
      const stats = fs.statSync(file);
      if (stats.mtime <= lastSyncDate) {
        continue;
      }
    }

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
  incremental: !!lastSyncDate,
  metadata: {
    diary_files: diaryFiles.length,
    entries_count: entries.length,
    processed: processed.length > 0 ? processed : undefined,
    errors: errors.length > 0 ? errors : undefined
  }
}));
