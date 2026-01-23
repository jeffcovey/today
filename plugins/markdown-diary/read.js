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

const diaryDirectory = config.diary_directory || (process.env.VAULT_PATH ? `${process.env.VAULT_PATH}/diary` : 'vault/diary');
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
 * Check if a plugin is enabled by reading config.toml
 */
function isPluginEnabled(pluginName) {
  try {
    const configPath = path.join(projectRoot, 'config.toml');
    if (!fs.existsSync(configPath)) {
      return false;
    }

    const configContent = fs.readFileSync(configPath, 'utf8');

    // Look for any [plugins.{pluginName}.*] section with enabled = true
    // Plugins can have multiple instances (e.g., google-calendar.personal, google-calendar.zazen)
    const pluginSectionRegex = new RegExp(`^\\[plugins\\.${pluginName}\\.\\w+\\]`, 'gm');
    const sections = configContent.match(pluginSectionRegex);

    if (!sections) {
      return false;
    }

    // Check each section to see if any has enabled = true
    for (const section of sections) {
      const sectionStart = configContent.indexOf(section);
      const nextSectionStart = configContent.indexOf('\n[', sectionStart + 1);
      const sectionContent = nextSectionStart === -1
        ? configContent.substring(sectionStart)
        : configContent.substring(sectionStart, nextSectionStart);

      if (sectionContent.includes('enabled = true')) {
        return true;
      }
    }

    return false;
  } catch (error) {
    // If we can't read the config, assume disabled
    return false;
  }
}

/**
 * Generate time tracking widget section
 */
function generateTimeTrackingSection(date) {
  return `## ⏱️ Time Tracking - Today

\`\`\`dataviewjs
await dv.view("scripts/time-tracking-widget", {
    startDate: "${date}",
    endDate: "${date}"
});
\`\`\``;
}

/**
 * Generate upcoming events section
 */
function generateUpcomingEventsSection(date) {
  return `## 📅 Upcoming Events

\`\`\`dataviewjs
await dv.view("scripts/calendar-events-widget");
\`\`\``;
}

/**
 * Generate plan navigation section (replacing simple link)
 */
function generatePlanNavigationSection(date) {
  const dateObj = new Date(date + 'T00:00:00');
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  const quarter = `Q${Math.ceil((dateObj.getMonth() + 1) / 3)}`;

  // Calculate ISO week number
  function getISOWeek(date) {
    const target = new Date(date.valueOf());
    const dayNr = (date.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
      target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
    }
    return Math.ceil((firstThursday - target) / 604800000) + 1;
  }
  const weekNum = String(getISOWeek(dateObj)).padStart(2, '0');

  const dailyFile = `${year}_${quarter}_${month}_W${weekNum}_${day}`;
  const weeklyFile = `${year}_${quarter}_${month}_W${weekNum}_00`;
  const monthlyFile = `${year}_${quarter}_${month}_00`;
  const quarterlyFile = `${year}_${quarter}_00`;
  const yearlyFile = `${year}_00`;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[dateObj.getDay()];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = monthNames[dateObj.getMonth()];

  return `## 📅 ${dayName}, ${monthName} ${day}, ${year}

📅 [[plans/${dailyFile}|Today's Plan]] | 📊 [[plans/${weeklyFile}|This Week]] | 📆 [[plans/${monthlyFile}|This Month]] | 🎯 [[plans/${quarterlyFile}|This Quarter]] | 📈 [[plans/${yearlyFile}|This Year]]`;
}

/**
 * Generate stage notice section using actual stages plugin configuration
 */
function generateStageNoticeSection(date) {
  try {
    const dateObj = new Date(date + 'T00:00:00');

    // Read stages plugin configuration from config.toml
    const configPath = path.join(projectRoot, 'config.toml');
    if (!fs.existsSync(configPath)) {
      return null;
    }

    const configContent = fs.readFileSync(configPath, 'utf8');

    // Extract stages plugin config section
    const stagesSectionMatch = configContent.match(/\[plugins\.stages\.default\]([\s\S]*?)(?=\n\[|$)/);
    if (!stagesSectionMatch) {
      return null;
    }

    const stagesSection = stagesSectionMatch[1];

    // Parse configuration values
    function getConfigValue(key, defaultValue) {
      const match = stagesSection.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
      return match ? match[1] : defaultValue;
    }

    // Stage definitions from config
    const stages = {
      front: {
        name: getConfigValue('front_stage_name', 'Front Stage'),
        description: getConfigValue('front_stage_description', 'Outward-facing work: meetings, calls, emails, support, communications'),
        emoji: '🎬'
      },
      back: {
        name: getConfigValue('back_stage_name', 'Back Stage'),
        description: getConfigValue('back_stage_description', 'Maintenance work: bills, bug fixes, organizing, admin tasks'),
        emoji: '🔧'
      },
      off: {
        name: getConfigValue('off_stage_name', 'Off Stage'),
        description: getConfigValue('off_stage_description', 'Personal time: nature, friends, reading, hobbies, rest'),
        emoji: '🎨'
      }
    };

    // Day-to-stage mapping from config
    const dayMapping = {
      monday: getConfigValue('monday', 'front'),
      tuesday: getConfigValue('tuesday', 'off'),
      wednesday: getConfigValue('wednesday', 'front'),
      thursday: getConfigValue('thursday', 'back'),
      friday: getConfigValue('friday', 'off'),
      saturday: getConfigValue('saturday', 'front'),
      sunday: getConfigValue('sunday', 'back')
    };

    // Get the day name and map to stage
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = days[dateObj.getDay()];
    const stageKey = dayMapping[dayName] || 'front';
    const stage = stages[stageKey] || stages.front;

    return `${stage.emoji} **${stage.name}** - ${stage.description}`;
  } catch (error) {
    // Fallback to default if config parsing fails
    return '🎬 **Front Stage** - Outward-facing work: meetings, calls, emails, support, communications';
  }
}

/**
 * Update or add a section in diary file using markers
 */
function updateDiarySection(filePath, sectionName, content) {
  if (!fs.existsSync(filePath)) return false;

  const startMarker = `<!-- TODAY:${sectionName}:START -->`;
  const endMarker = `<!-- TODAY:${sectionName}:END -->`;

  let fileContent = fs.readFileSync(filePath, 'utf8');

  const newSection = content ? `${startMarker}\n${content}\n${endMarker}` : '';

  // Check if markers already exist
  const startIndex = fileContent.indexOf(startMarker);
  const endIndex = fileContent.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1) {
    // Replace existing section
    const before = fileContent.substring(0, startIndex);
    const after = fileContent.substring(endIndex + endMarker.length);
    fileContent = before + newSection + after;
  } else if (content) {
    // Add new section after front matter
    const frontMatterMatch = fileContent.match(/^---\n[\s\S]*?\n---\n/);
    if (frontMatterMatch) {
      const frontMatter = frontMatterMatch[0];
      const rest = fileContent.substring(frontMatter.length);
      fileContent = frontMatter + '\n' + newSection + '\n' + rest;
    } else {
      // No front matter, add at beginning
      fileContent = newSection + '\n\n' + fileContent;
    }
  }

  fs.writeFileSync(filePath, fileContent, 'utf8');
  return true;
}

/**
 * Create today's diary file if it doesn't exist, with dynamic sections
 * Returns true if file was created, false if it already existed
 */
function ensureTodaysDiaryFile() {
  const today = getTodayDateString();
  const filePath = path.join(diaryDir, `${today}.md`);

  const fileExists = fs.existsSync(filePath);

  if (!fileExists) {
    // Create minimal front matter template
    const content = `---
date: ${today}
cssclasses: dashboard
obsidianUIMode: preview
---

`;
    fs.writeFileSync(filePath, content, 'utf8');
  }

  // Add or update dynamic sections based on enabled plugins
  // Note: Add in reverse order since new sections are inserted after front matter
  const timeTrackingEnabled = isPluginEnabled('markdown-time-tracking');
  const plansEnabled = isPluginEnabled('markdown-plans');
  const stagesEnabled = isPluginEnabled('stages');
  const calendarEnabled = isPluginEnabled('google-calendar') || isPluginEnabled('public-calendars');

  // Insert sections in REVERSE order of desired final order
  // Desired: PLAN_NAVIGATION, STAGE_NOTICE, TIME_TRACKING, UPCOMING_EVENTS
  // So insert: UPCOMING_EVENTS, TIME_TRACKING, STAGE_NOTICE, PLAN_NAVIGATION
  if (calendarEnabled) {
    updateDiarySection(filePath, 'UPCOMING_EVENTS', generateUpcomingEventsSection(today));
  }

  if (timeTrackingEnabled) {
    updateDiarySection(filePath, 'TIME_TRACKING', generateTimeTrackingSection(today));
  }

  if (stagesEnabled) {
    updateDiarySection(filePath, 'STAGE_NOTICE', generateStageNoticeSection(today));
  }

  if (plansEnabled) {
    updateDiarySection(filePath, 'PLAN_NAVIGATION', generatePlanNavigationSection(today));
  }

  return !fileExists;
}

/**
 * Check if a diary file only contains the auto-generated template (no real content)
 */
function isEmptyDiaryFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const { body } = parseFrontMatter(content);

    // Remove all marker comments (<!-- TODAY:*:START --> and <!-- TODAY:*:END -->)
    const contentWithoutMarkers = body.replace(/<!--\s*TODAY:[^:]+:(START|END)\s*-->/g, '');

    // Remove all auto-generated sections (time tracking widgets, plan navigation, stage notices)
    let contentWithoutAutoSections = contentWithoutMarkers;

    // Remove time tracking sections
    contentWithoutAutoSections = contentWithoutAutoSections.replace(/## ⏱️ Time Tracking - Today[\s\S]*?```dataviewjs[\s\S]*?```/g, '');

    // Remove plan navigation sections (with emoji headers and links)
    contentWithoutAutoSections = contentWithoutAutoSections.replace(/## 📅 [^,]+, [^,]+ \d+, \d+[\s\S]*?📅 \[\[plans\/[^\]]+\]\][\s\S]*?\[\[plans\/[^\]]+\]\]/g, '');

    // Remove stage notice lines (emoji + stage name + focus)
    contentWithoutAutoSections = contentWithoutAutoSections.replace(/[🎬🔧🎨] \*\*[^*]+\*\* - [^\n]+/g, '');

    // Remove any remaining dataviewjs blocks
    contentWithoutAutoSections = contentWithoutAutoSections.replace(/```dataviewjs[\s\S]*?```/g, '');

    // Check if what's left is only whitespace, empty sections, or common empty patterns
    const trimmed = contentWithoutAutoSections.trim();

    // File is empty if:
    // 1. No content after removing auto-generated sections
    // 2. Only empty markdown sections (## Title with no content)
    // 3. Only whitespace and newlines
    if (trimmed === '') {
      return true;
    }

    // Check for files with only empty section headers
    const linesAfterTrim = trimmed.split('\n').filter(line => line.trim() !== '');
    const onlyEmptyHeaders = linesAfterTrim.every(line =>
      line.match(/^#+\s+/) || // Section headers
      line.match(/^-\s*$/) ||  // Empty bullet points
      line.trim() === ''       // Whitespace
    );

    return onlyEmptyHeaders;
  } catch {
    return false;
  }
}

/**
 * Remove TODAY sections from old diary files (sections only relevant for current day)
 */
function removeTodaySectionsFromOldFiles() {
  const today = getTodayDateString();
  const cleaned = [];
  const skipped = [];

  if (!fs.existsSync(diaryDir)) {
    return { cleaned, skipped };
  }

  const files = fs.readdirSync(diaryDir)
    .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f));

  for (const file of files) {
    const fileDate = file.replace('.md', '');

    // Skip today's file - keep TODAY sections active
    if (fileDate === today) {
      continue;
    }

    const filePath = path.join(diaryDir, file);

    try {
      const content = fs.readFileSync(filePath, 'utf8');

      // Check if file has any TODAY sections
      if (!content.includes('<!-- TODAY:')) {
        continue;
      }

      const originalSize = Buffer.byteLength(content, 'utf8');

      // Remove all TODAY sections (between START and END markers, including markers)
      let cleanedContent = content.replace(/<!-- TODAY:[^:]+:START -->[\s\S]*?<!-- TODAY:[^:]+:END -->\n?/g, '');

      // Clean up any extra blank lines that might result from section removal
      cleanedContent = cleanedContent.replace(/\n\n\n+/g, '\n\n');

      // Only write if content actually changed
      if (cleanedContent !== content) {
        fs.writeFileSync(filePath, cleanedContent, 'utf8');
        const newSize = Buffer.byteLength(cleanedContent, 'utf8');

        cleaned.push({
          file,
          date: fileDate,
          originalSize,
          newSize,
          bytesRemoved: originalSize - newSize
        });
      }
    } catch (error) {
      skipped.push({ file, reason: `processing failed: ${error.message}` });
    }
  }

  return { cleaned, skipped };
}

/**
 * Clean up empty diary files from previous days
 * Removes files that contain only auto-generated content (markers, widgets, navigation)
 * or are completely empty/whitespace-only
 */
function cleanupEmptyDiaryFiles() {
  const today = getTodayDateString();
  const removed = [];
  const skipped = [];

  if (!fs.existsSync(diaryDir)) {
    return { removed, skipped };
  }

  const files = fs.readdirSync(diaryDir)
    .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f));

  for (const file of files) {
    const fileDate = file.replace('.md', '');

    // Skip today's file - never remove it
    if (fileDate === today) {
      skipped.push({ file, reason: 'current day' });
      continue;
    }

    const filePath = path.join(diaryDir, file);

    if (isEmptyDiaryFile(filePath)) {
      try {
        const stats = fs.statSync(filePath);
        fs.unlinkSync(filePath);
        removed.push({
          file,
          date: fileDate,
          size: stats.size,
          lastModified: stats.mtime.toISOString().split('T')[0]
        });
      } catch (error) {
        skipped.push({ file, reason: `deletion failed: ${error.message}` });
      }
    }
  }

  return { removed, skipped };
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

// Remove TODAY sections from old diary files (not relevant after the day passes)
const sectionCleanupResult = removeTodaySectionsFromOldFiles();

// Clean up empty diary files from previous days
const cleanupResult = cleanupEmptyDiaryFiles();
removedEmptyFiles = cleanupResult.removed;

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
// files_processed at top level tells plugin-loader which files were processed for incremental sync
const filesProcessed = diaryFiles.map(f => path.basename(f));
console.log(JSON.stringify({
  entries: entries,
  incremental: isIncremental,
  files_processed: filesProcessed.length > 0 ? filesProcessed : undefined,
  metadata: {
    diary_files: diaryFiles.length,
    entries_count: entries.length,
    processed: processed.length > 0 ? processed : undefined,
    created_today: createdTodaysFile ? getTodayDateString() + '.md' : undefined,
    cleanup: {
      sections_cleaned: sectionCleanupResult.cleaned.length > 0 ? sectionCleanupResult.cleaned : undefined,
      removed_empty: removedEmptyFiles.length > 0 ? removedEmptyFiles : undefined,
      skipped_files: cleanupResult.skipped.length > 0 ? cleanupResult.skipped : undefined,
      section_cleanup_failed: sectionCleanupResult.skipped.length > 0 ? sectionCleanupResult.skipped : undefined,
      total_sections_cleaned: sectionCleanupResult.cleaned.length,
      total_removed: removedEmptyFiles.length,
      total_skipped: cleanupResult.skipped.length
    },
    errors: errors.length > 0 ? errors : undefined
  }
}));
