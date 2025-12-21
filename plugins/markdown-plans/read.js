#!/usr/bin/env node

/**
 * markdown-plans context plugin
 *
 * Provides the current plan hierarchy (year → quarter → month → week → day)
 * as context for AI assistants to align daily work with long-term goals.
 *
 * During sync, this plugin:
 * 1. Creates today's and tomorrow's daily plan files from templates
 * 2. Generates daily summaries for past days (yesterday and any missing)
 *
 * File naming pattern:
 * - Year:    YYYY_00.md           (e.g., 2025_00.md)
 * - Quarter: YYYY_Q#_00.md        (e.g., 2025_Q4_00.md)
 * - Month:   YYYY_Q#_MM_00.md     (e.g., 2025_Q4_12_00.md)
 * - Week:    YYYY_Q#_MM_W##_00.md (e.g., 2025_Q4_12_W51_00.md)
 * - Day:     YYYY_Q#_MM_W##_DD.md (e.g., 2025_Q4_12_W51_17.md)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { schemas, getPluginTypes } from '../../src/plugin-schemas.js';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

const plansDirectory = config.plans_directory || 'vault/plans';
const templatesDirectory = config.templates_directory || 'vault/plans/templates';
const linkDailyNotes = config.link_daily_notes !== false; // opt-out, default true
const plansDir = path.join(projectRoot, plansDirectory);
const templatesDir = path.join(projectRoot, templatesDirectory);

/**
 * Calculate ISO week number
 */
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Get quarter from month (1-12)
 */
function getQuarter(month) {
  return Math.floor((month - 1) / 3) + 1;
}

/**
 * Get plan file paths for a given date
 */
function getPlanFilePaths(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const week = getISOWeek(date);
  const quarter = getQuarter(month);

  const mm = String(month).padStart(2, '0');
  const ww = String(week).padStart(2, '0');
  const dd = String(day).padStart(2, '0');

  return {
    year: {
      path: path.join(plansDir, `${year}_00.md`),
      label: `${year} Annual Plan`,
      type: 'year',
    },
    quarter: {
      path: path.join(plansDir, `${year}_Q${quarter}_00.md`),
      label: `Q${quarter} ${year} Quarterly Plan`,
      type: 'quarter',
    },
    month: {
      path: path.join(plansDir, `${year}_Q${quarter}_${mm}_00.md`),
      label: `${date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} Monthly Plan`,
      type: 'month',
    },
    week: {
      path: path.join(plansDir, `${year}_Q${quarter}_${mm}_W${ww}_00.md`),
      label: `Week ${week} Plan`,
      type: 'week',
    },
    day: {
      path: path.join(plansDir, `${year}_Q${quarter}_${mm}_W${ww}_${dd}.md`),
      label: `${date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
      type: 'day',
    },
  };
}

/**
 * Parse frontmatter from markdown content
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yaml = match[1];
  const body = content.slice(match[0].length).trim();

  // Simple YAML parser for key: value pairs
  const frontmatter = {};
  for (const line of yaml.split('\n')) {
    const keyMatch = line.match(/^(\w+):\s*"?([^"]*)"?$/);
    if (keyMatch) {
      frontmatter[keyMatch[1]] = keyMatch[2].trim();
    }
  }

  return { frontmatter, body };
}

/**
 * Clean content by removing Obsidian-specific syntax
 */
function cleanContent(content) {
  let cleaned = content;

  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  // Remove Obsidian callout blocks (> [!type] lines and their content)
  cleaned = cleaned.replace(/^>\s*\[![\w-]+\].*$\n?/gm, '');

  // Remove code blocks (```...```)
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');

  // Remove blockquote continuation lines (lines starting with >)
  cleaned = cleaned.replace(/^>\s*.*$\n?/gm, '');

  // Remove Dataview/inline queries
  cleaned = cleaned.replace(/`=this\.[^`]+`/g, '');

  // Clean up multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * Extract key sections from plan content
 */
function extractSections(body) {
  const sections = {};

  // Extract ## headers and their content
  const sectionRegex = /^## (.+)$/gm;
  const matches = [...body.matchAll(sectionRegex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const sectionName = match[1].trim();
    const startIndex = match.index + match[0].length;
    const endIndex = matches[i + 1]?.index || body.length;
    let content = body.slice(startIndex, endIndex).trim();

    // Clean Obsidian-specific syntax
    content = cleanContent(content);

    // Skip empty sections and certain dynamic sections
    if (!content) continue;
    if (sectionName.includes('Completed Today')) continue;
    if (sectionName.includes('Due or Scheduled')) continue;

    sections[sectionName] = content;
  }

  return sections;
}

/**
 * Format a single plan file for context
 */
function formatPlanContext(planInfo, content) {
  const { frontmatter, body } = parseFrontmatter(content);
  const sections = extractSections(body);

  const lines = [];
  lines.push(`### ${planInfo.label}`);

  // Add summary if available
  const summaryKey = `${planInfo.type === 'day' ? 'daily' : planInfo.type === 'week' ? 'weekly' : planInfo.type}ly_summary`;
  if (frontmatter[summaryKey] || frontmatter.daily_summary || frontmatter.weekly_summary) {
    const summary = frontmatter[summaryKey] || frontmatter.daily_summary || frontmatter.weekly_summary;
    if (summary) {
      lines.push('');
      lines.push(`**Summary:** ${summary}`);
    }
  }

  // Add key sections based on plan type
  const prioritySections = [
    'Goals',
    'Objectives',
    'Focus Areas',
    'Priorities',
    'Top Priorities',
    "Today's Focus",
  ];

  for (const sectionName of Object.keys(sections)) {
    // Include priority/goal sections
    const isPriority = prioritySections.some(p =>
      sectionName.toLowerCase().includes(p.toLowerCase())
    );

    if (isPriority) {
      lines.push('');
      lines.push(`**${sectionName}:**`);
      lines.push(sections[sectionName]);
    }
  }

  // For day plans, include reflection if present
  if (planInfo.type === 'day' && sections['Reflection']) {
    const reflection = sections['Reflection'];
    if (reflection && !reflection.includes('What went well?')) {
      lines.push('');
      lines.push('**Reflection:**');
      lines.push(reflection);
    }
  }

  return lines.join('\n');
}

/**
 * Get template variables for a given date
 */
function getTemplateVariables(date) {
  const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long' });
  const monthName = date.toLocaleDateString('en-US', { month: 'long' });
  const fullDate = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return {
    '{{YEAR}}': String(date.getFullYear()),
    '{{MONTH}}': String(date.getMonth() + 1),
    '{{MONTH_NAME}}': monthName,
    '{{DAY}}': String(date.getDate()),
    '{{WEEK}}': String(getISOWeek(date)),
    '{{QUARTER}}': String(getQuarter(date.getMonth() + 1)),
    '{{DAY_OF_WEEK}}': dayOfWeek,
    '{{FULL_DATE}}': fullDate,
    '{{PRIORITIES_FROM_DATABASE}}': '',
  };
}

/**
 * Create a daily plan from template if it doesn't exist
 */
function ensureDailyPlan(planInfo, date) {
  if (fs.existsSync(planInfo.path)) {
    return { existed: true };
  }

  const templatePath = path.join(templatesDir, 'daily-plan.md');
  if (!fs.existsSync(templatePath)) {
    return { error: `Template not found: ${templatePath}` };
  }

  const template = fs.readFileSync(templatePath, 'utf-8');
  const variables = getTemplateVariables(date);

  let content = template;
  for (const [key, value] of Object.entries(variables)) {
    content = content.split(key).join(value);
  }

  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(planInfo.path, content, 'utf-8');

  return { created: true, file: path.basename(planInfo.path) };
}

/**
 * Get all plan files sorted chronologically by filename
 * Filenames are designed to sort chronologically (YYYY_Q#_MM_W##_DD.md)
 */
function getSortedPlanFiles() {
  if (!fs.existsSync(plansDir)) return [];

  const files = fs.readdirSync(plansDir)
    .filter(f => f.endsWith('.md') && /^\d{4}_/.test(f))
    .sort();

  return files;
}

/**
 * Get previous and next plan files for a given plan file
 */
function getPrevNextPlans(currentFile) {
  const files = getSortedPlanFiles();
  const currentIndex = files.indexOf(currentFile);

  if (currentIndex === -1) return { prev: null, next: null };

  const prev = currentIndex > 0 ? files[currentIndex - 1] : null;
  const next = currentIndex < files.length - 1 ? files[currentIndex + 1] : null;

  return { prev, next };
}

/**
 * Build Obsidian navigation links for prev/next plans
 * Uses float:right for the Next link to right-justify it
 */
function buildNavLinks(currentFile) {
  const { prev, next } = getPrevNextPlans(currentFile);

  if (!prev && !next) return null;

  const parts = [];

  if (prev) {
    const prevName = prev.replace('.md', '');
    parts.push(`[[plans/${prevName}|← Previous]]`);
  }

  if (next) {
    const nextName = next.replace('.md', '');
    parts.push(`<span style="float: right;">[[plans/${nextName}|Next →]]</span>`);
  }

  return parts.join(' ');
}

/**
 * Add navigation links to a plan file if not already present
 */
function addNavigationLinks(filePath) {
  const filename = path.basename(filePath);
  const navLinks = buildNavLinks(filename);

  if (!navLinks) return false;

  let content = fs.readFileSync(filePath, 'utf-8');

  // Check if navigation already exists
  if (content.includes('← Previous') || content.includes('Next →')) {
    return false;
  }

  // Add navigation after the header line (# Daily Plan - ... or # Weekly Plan - ... etc)
  const headerMatch = content.match(/^(# .+)$/m);
  if (headerMatch) {
    const newContent = content.replace(
      headerMatch[0],
      `${headerMatch[0]}\n${navLinks}`
    );

    if (newContent !== content) {
      fs.writeFileSync(filePath, newContent, 'utf-8');
      return true;
    }
  }

  return false;
}

/**
 * Add navigation links to all plan files that are missing them
 */
function addNavigationToAllFiles() {
  const added = [];
  const files = getSortedPlanFiles();

  for (const file of files) {
    const filePath = path.join(plansDir, file);

    if (addNavigationLinks(filePath)) {
      added.push({ file });
    }
  }

  return added;
}

/**
 * Generate AI summary for a specific date
 * Uses bin/today dry-run --date to get the full context for that date
 */
async function generateDailySummary(dateStr, planFilePath) {
  // Get API key
  let apiKey = '';
  try {
    apiKey = execSync('npx dotenvx get TODAY_ANTHROPIC_KEY 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }

  if (!apiKey || apiKey.includes('not set') || apiKey === '') {
    return null;
  }

  // Get data context using bin/today dry-run --date
  let dataContext = '';
  try {
    dataContext = execSync(`bin/today dry-run --date ${dateStr} --no-sync 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 30000
    });
    // Filter out dotenvx noise and status messages
    dataContext = dataContext.split('\n')
      .filter(line => !line.includes('[dotenvx') && !line.startsWith('🔍') && !line.startsWith('📊') && !line.startsWith('✅'))
      .join('\n')
      .trim();
  } catch {
    dataContext = '';
  }

  // Include plan file content if it exists
  let planContent = '';
  if (fs.existsSync(planFilePath)) {
    const fileContent = fs.readFileSync(planFilePath, 'utf-8');
    const { body } = parseFrontmatter(fileContent);
    const cleanedBody = cleanContent(body);
    if (cleanedBody && cleanedBody.length > 50) {
      planContent = `### Daily Plan File\n${cleanedBody.slice(0, 2000)}`;
    }
  }

  if (!dataContext && !planContent) {
    return 'No activity recorded this day.';
  }

  // Build prompt for summary generation
  const prompt = `# Daily Summary Generation

## Task
Generate a 2-3 sentence narrative summary for **${dateStr}** (a single day).

## Guidelines
- Focus on what was accomplished (major wins, completed tasks)
- Capture the overall theme or focus of the day
- Note any challenges or insights
- Be qualitative and narrative, not just a list
- Make it meaningful and readable

## Context for ${dateStr}
${dataContext}

${planContent ? `\n${planContent}` : ''}

---

Write ONLY the 2-3 sentence summary for ${dateStr}, nothing else:`;

  // Get model from config (use haiku for summaries - fast and cheap)
  let model = 'claude-haiku-4-5-20251001';
  try {
    const configModel = execSync('bin/get-config ai.claude_model 2>/dev/null', { encoding: 'utf8' }).trim();
    if (configModel) model = configModel;
  } catch { /* use default */ }
  if (process.env.CLAUDE_MODEL) model = process.env.CLAUDE_MODEL;

  // Call API
  try {
    const tempPromptFile = `/tmp/summary-prompt-${Date.now()}.txt`;
    fs.writeFileSync(tempPromptFile, prompt);

    const response = execSync(
      `npx dotenvx run --quiet -- node -e "const Anthropic = require('@anthropic-ai/sdk'); const fs = require('fs'); const client = new Anthropic({ apiKey: process.env.TODAY_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY }); (async () => { const prompt = fs.readFileSync('${tempPromptFile}', 'utf-8'); const response = await client.messages.create({ model: '${model}', max_tokens: 300, temperature: 0.7, messages: [{ role: 'user', content: prompt }] }); console.log(response.content[0].text.trim()); })();"`,
      { encoding: 'utf8', timeout: 30000 }
    );

    fs.unlinkSync(tempPromptFile);
    return response.trim();
  } catch (error) {
    return null;
  }
}

/**
 * Check if a plan file needs a summary
 */
function needsSummary(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const content = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter } = parseFrontmatter(content);

  // Has no daily_summary or it's empty
  return !frontmatter.daily_summary || frontmatter.daily_summary.trim() === '';
}

/**
 * Add summary to a plan file's frontmatter and add display callout
 */
function addSummaryToFile(filePath, summary) {
  let content = fs.readFileSync(filePath, 'utf-8');

  // Escape quotes in summary for YAML
  const escapedSummary = summary.replace(/"/g, '\\"');

  // Replace empty daily_summary with the new one
  content = content.replace(
    /daily_summary:\s*$/m,
    `daily_summary: "${escapedSummary}"`
  );

  // If that didn't work, try replacing daily_summary: with empty value
  if (content.includes('daily_summary:') && !content.includes(`"${escapedSummary}"`)) {
    content = content.replace(
      /daily_summary:\s*\n/m,
      `daily_summary: "${escapedSummary}"\n`
    );
  }

  // Add Day Summary callout in TODAY_FOCUS section if not already present
  const summaryCallout = '> [!summary] Day Summary\n> `=this.daily_summary`';
  if (!content.includes('[!summary] Day Summary')) {
    content = content.replace(
      /<!-- \/TODAY_FOCUS -->/,
      `${summaryCallout}\n<!-- /TODAY_FOCUS -->`
    );
  }

  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Add Day Summary callout to past files that have summaries but are missing the callout
 */
function addSummaryCalloutToPastFiles(today, maxDaysBack = 7) {
  const added = [];

  for (let i = 1; i <= maxDaysBack; i++) {
    const pastDate = new Date(today);
    pastDate.setDate(pastDate.getDate() - i);

    const planInfo = getPlanFilePaths(pastDate);
    if (!fs.existsSync(planInfo.day.path)) continue;

    let content = fs.readFileSync(planInfo.day.path, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);

    // Skip if no summary or already has callout
    if (!frontmatter.daily_summary || frontmatter.daily_summary.trim() === '') continue;
    if (content.includes('[!summary] Day Summary')) continue;

    // Add the callout
    const summaryCallout = '> [!summary] Day Summary\n> `=this.daily_summary`';
    const newContent = content.replace(
      /<!-- \/TODAY_FOCUS -->/,
      `${summaryCallout}\n<!-- /TODAY_FOCUS -->`
    );

    if (newContent !== content) {
      fs.writeFileSync(planInfo.day.path, newContent, 'utf-8');
      added.push({
        file: path.basename(planInfo.day.path),
        date: formatDateStr(pastDate),
      });
    }
  }

  return added;
}

/**
 * Get list of recent past days that need summaries (up to N days back)
 */
function getPastDaysNeedingSummaries(today, maxDaysBack = 7) {
  const daysNeedingSummaries = [];

  for (let i = 1; i <= maxDaysBack; i++) {
    const pastDate = new Date(today);
    pastDate.setDate(pastDate.getDate() - i);

    const planInfo = getPlanFilePaths(pastDate);
    if (fs.existsSync(planInfo.day.path) && needsSummary(planInfo.day.path)) {
      daysNeedingSummaries.push({
        date: pastDate,
        dateStr: formatDateStr(pastDate),
        path: planInfo.day.path,
        filename: path.basename(planInfo.day.path),
      });
    }
  }

  return daysNeedingSummaries;
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDateStr(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Fix "done today" in past daily plan files
 * Changes `done today` to `done on YYYY-MM-DD` for the specific date
 */
function fixDoneTodayInPastFiles(today, maxDaysBack = 7) {
  const fixed = [];

  for (let i = 1; i <= maxDaysBack; i++) {
    const pastDate = new Date(today);
    pastDate.setDate(pastDate.getDate() - i);

    const planInfo = getPlanFilePaths(pastDate);
    if (!fs.existsSync(planInfo.day.path)) continue;

    let content = fs.readFileSync(planInfo.day.path, 'utf-8');
    const dateStr = formatDateStr(pastDate);

    // Check if file still has "done today" that needs fixing
    if (!content.includes('done today')) continue;

    // Replace "done today" with "done on YYYY-MM-DD"
    const newContent = content.replace(
      /```tasks\n(\s*)done today\n/g,
      `\`\`\`tasks\n$1done on ${dateStr}\n`
    );

    if (newContent !== content) {
      fs.writeFileSync(planInfo.day.path, newContent, 'utf-8');
      fixed.push({
        file: path.basename(planInfo.day.path),
        date: dateStr,
      });
    }
  }

  return fixed;
}

/**
 * Remove DUE_TODAY section from past daily plan files
 * This section shows tasks due "before tomorrow" which becomes stale after the day passes
 */
function removeDueTodayFromPastFiles(today, maxDaysBack = 7) {
  const removed = [];

  for (let i = 1; i <= maxDaysBack; i++) {
    const pastDate = new Date(today);
    pastDate.setDate(pastDate.getDate() - i);

    const planInfo = getPlanFilePaths(pastDate);
    if (!fs.existsSync(planInfo.day.path)) continue;

    let content = fs.readFileSync(planInfo.day.path, 'utf-8');

    // Check if file still has DUE_TODAY section
    if (!content.includes('<!-- DUE_TODAY:')) continue;

    // Remove the entire DUE_TODAY section
    const newContent = content.replace(
      /<!-- DUE_TODAY:[\s\S]*?<!-- \/DUE_TODAY -->\n*/g,
      ''
    );

    if (newContent !== content) {
      fs.writeFileSync(planInfo.day.path, newContent, 'utf-8');
      removed.push({
        file: path.basename(planInfo.day.path),
        date: formatDateStr(pastDate),
      });
    }
  }

  return removed;
}

/**
 * Remove unedited Reflection section from past daily plan files
 * Only removes if the placeholder text was never changed
 */
function removeEmptyReflectionFromPastFiles(today, maxDaysBack = 7) {
  const removed = [];

  // The exact unedited placeholder pattern
  const emptyReflectionPattern = /<!-- REFLECTION: End of day notes and insights -->\n## 💭 Reflection\n\n\*End of day: What went well\? What could improve\? Any insights\?\*\n<!-- \/REFLECTION -->\n*/g;

  for (let i = 1; i <= maxDaysBack; i++) {
    const pastDate = new Date(today);
    pastDate.setDate(pastDate.getDate() - i);

    const planInfo = getPlanFilePaths(pastDate);
    if (!fs.existsSync(planInfo.day.path)) continue;

    let content = fs.readFileSync(planInfo.day.path, 'utf-8');

    // Check if file has the unedited reflection section
    if (!emptyReflectionPattern.test(content)) continue;

    // Reset regex state
    emptyReflectionPattern.lastIndex = 0;

    // Remove the unedited reflection section
    const newContent = content.replace(emptyReflectionPattern, '');

    if (newContent !== content) {
      fs.writeFileSync(planInfo.day.path, newContent, 'utf-8');
      removed.push({
        file: path.basename(planInfo.day.path),
        date: formatDateStr(pastDate),
      });
    }
  }

  return removed;
}

/**
 * Map of plugin types to their primary date column for filtering
 */
const dateColumnMap = {
  'time-logs': 'start_time',
  'diary': 'date',
  'events': 'start_date',
  'tasks': 'completed_at',
  'habits': 'date',
  'issues': 'opened_at',
};

/**
 * Get planning data for a target date using ALL plugin types from schemas
 * This is forward-looking: open tasks, upcoming events, open issues, etc.
 */
function getPlanningDataWithSchemas(targetDateStr, targetDayOfWeek) {
  const dbPath = path.join(projectRoot, '.data/today.db');
  if (!fs.existsSync(dbPath)) {
    return { sections: [], contextSections: [], stageInfo: null };
  }

  const sections = [];
  const contextSections = [];

  // Get ALL plugin types from schemas
  const allPluginTypes = getPluginTypes();

  for (const pluginType of allPluginTypes) {
    const schema = schemas[pluginType];
    if (!schema) continue;

    const ai = schema.ai || {};

    // Context plugins don't have tables - run them separately
    if (!schema.table) {
      continue; // Handle context plugins below
    }

    const tableName = schema.table;
    const dateColumn = dateColumnMap[pluginType];

    // Build forward-looking query based on plugin type
    let query;
    const columns = Object.entries(schema.fields)
      .filter(([name, field]) => !field.dbOnly && name !== 'id')
      .map(([name]) => name);

    if (pluginType === 'events') {
      // Events scheduled for target date
      query = `SELECT ${columns.join(', ')} FROM ${tableName} WHERE date(start_date) = '${targetDateStr}' ORDER BY start_date`;
    } else if (pluginType === 'tasks') {
      // Open tasks: due by target date, overdue, or high priority
      query = `SELECT ${columns.join(', ')} FROM ${tableName} WHERE status != 'completed' AND (date(due_date) <= '${targetDateStr}' OR (due_date IS NULL AND priority IN ('highest', 'high'))) ORDER BY CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 6 END, due_date ASC LIMIT 30`;
    } else if (pluginType === 'issues') {
      // Open issues
      query = `SELECT ${columns.join(', ')} FROM ${tableName} WHERE state = 'open' ORDER BY opened_at DESC LIMIT 20`;
    } else if (pluginType === 'habits') {
      // Recent habits to know routines
      query = `SELECT DISTINCT title, status, category FROM ${tableName} WHERE date >= date('${targetDateStr}', '-3 days') ORDER BY category, title`;
    } else if (pluginType === 'diary') {
      // Recent diary for context
      query = `SELECT ${columns.join(', ')} FROM ${tableName} WHERE date >= date('${targetDateStr}', '-2 days') ORDER BY date DESC LIMIT 5`;
    } else if (pluginType === 'time-logs') {
      // Recent time logs for context
      query = `SELECT ${columns.join(', ')} FROM ${tableName} WHERE date(start_time) >= date('${targetDateStr}', '-1 day') ORDER BY start_time DESC LIMIT 10`;
    } else if (pluginType === 'email') {
      // Skip email for planning - too noisy
      continue;
    } else if (dateColumn) {
      // Generic query for other types with date columns
      query = `SELECT ${columns.join(', ')} FROM ${tableName} WHERE date(${dateColumn}) = '${targetDateStr}' ORDER BY ${dateColumn} LIMIT 20`;
    } else {
      continue;
    }

    try {
      const result = execSync(`sqlite3 -json "${dbPath}" "${query}"`, { encoding: 'utf8' });
      const rows = JSON.parse(result || '[]');

      if (rows.length > 0) {
        sections.push({
          type: pluginType,
          name: ai.name || pluginType,
          description: ai.description ? ai.description.split('\n')[0] : '',
          count: rows.length,
          data: rows,
        });
      }
    } catch {
      // Table might not exist or query failed - skip
    }
  }

  // Run context plugins (weather, stages, vault-changes)
  // These output formatted text, not JSON - just capture and include
  try {
    const contextOutput = execSync('bin/context show 2>/dev/null', { encoding: 'utf8', timeout: 15000 });
    if (contextOutput && contextOutput.trim()) {
      contextSections.push({
        type: 'context',
        name: 'Current Context',
        content: contextOutput.trim(),
      });
    }
  } catch {
    // Context command failed - skip
  }

  // Get stage info for target day
  const stageInfo = getStageForDay(targetDayOfWeek);

  return { sections, contextSections, stageInfo };
}

/**
 * Get the stage (front/back/off) for a given day of week
 */
function getStageForDay(dayOfWeek) {
  // Read from config.toml
  const stages = {
    front: { name: 'Front Stage', description: 'Outward-facing work: meetings, calls, emails, support', tag: '#stage/front-stage' },
    back: { name: 'Back Stage', description: 'Maintenance work: bills, bug fixes, organizing, admin', tag: '#stage/back-stage' },
    off: { name: 'Off Stage', description: 'Personal time: nature, friends, reading, rest', tag: '#stage/off-stage' },
  };

  // Default day mapping (can be overridden by config)
  const defaultDayMapping = {
    sunday: 'back', monday: 'front', tuesday: 'off', wednesday: 'front',
    thursday: 'back', friday: 'off', saturday: 'front',
  };

  // Try to read from config
  let dayMapping = defaultDayMapping;
  try {
    const configPath = path.join(projectRoot, 'config.toml');
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      // Simple parsing for [stages] section
      const stagesMatch = configContent.match(/\[stages\]([\s\S]*?)(?=\n\[|$)/);
      if (stagesMatch) {
        const stagesSection = stagesMatch[1];
        for (const day of Object.keys(defaultDayMapping)) {
          const match = stagesSection.match(new RegExp(`${day}\\s*=\\s*"(\\w+)"`));
          if (match) {
            dayMapping[day] = match[1];
          }
        }
      }
    }
  } catch { /* use defaults */ }

  const stageKey = dayMapping[dayOfWeek.toLowerCase()] || 'front';
  return { ...stages[stageKey], stageKey };
}

/**
 * Format planning data section for AI prompt
 */
function formatPlanningSection(section) {
  const lines = [`### ${section.name} (${section.count})`];

  for (const row of section.data) {
    if (section.type === 'events') {
      const time = row.start_date ? row.start_date.substring(11, 16) : 'all-day';
      const calendar = row.calendar_name ? ` [${row.calendar_name}]` : '';
      lines.push(`- ${time}: ${row.title}${row.location ? ` @ ${row.location}` : ''}${calendar}`);
    } else if (section.type === 'tasks') {
      const due = row.due_date ? ` (due: ${row.due_date})` : '';
      const priority = row.priority ? ` [${row.priority}]` : '';
      // Extract stage from metadata if present
      let stage = '';
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          if (meta.stage) stage = ` ${meta.stage}`;
        } catch { /* ignore */ }
      }
      lines.push(`- [ ] ${row.title}${priority}${due}${stage}`);
    } else if (section.type === 'issues') {
      const source = row.source ? row.source.split('/')[0] : 'unknown';
      lines.push(`- [${source}] ${row.title}`);
    } else if (section.type === 'habits') {
      const category = row.category ? `[${row.category}] ` : '';
      lines.push(`- ${category}${row.title}`);
    } else {
      lines.push(`- ${JSON.stringify(row)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Check if tomorrow's plan needs priorities filled
 */
function needsPriorities(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const content = fs.readFileSync(filePath, 'utf-8');

  // Check if TOP_PRIORITIES section is empty
  const prioritiesMatch = content.match(/<!-- TOP_PRIORITIES:.*?-->\s*## 📋 Top Priorities\s*([\s\S]*?)<!-- \/TOP_PRIORITIES -->/);
  if (!prioritiesMatch) return false;

  const prioritiesContent = prioritiesMatch[1].trim();
  return prioritiesContent === '' || prioritiesContent === '{{PRIORITIES_FROM_DATABASE}}';
}

/**
 * Generate AI suggestions for tomorrow's plan
 */
async function generateTomorrowSuggestions(tomorrowStr, planFilePath) {
  // Get API key
  let apiKey = '';
  try {
    apiKey = execSync('npx dotenvx get TODAY_ANTHROPIC_KEY 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }

  if (!apiKey || apiKey.includes('not set') || apiKey === '') {
    return null;
  }

  // Get day of week for tomorrow
  const tomorrowDate = new Date(tomorrowStr + 'T12:00:00');
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const tomorrowDayOfWeek = days[tomorrowDate.getDay()];
  const tomorrowDayName = tomorrowDayOfWeek.charAt(0).toUpperCase() + tomorrowDayOfWeek.slice(1);

  // Get tomorrow's data using ALL plugin types from schemas
  const { sections, contextSections, stageInfo } = getPlanningDataWithSchemas(tomorrowStr, tomorrowDayOfWeek);

  if (sections.length === 0 && contextSections.length === 0) {
    return null;
  }

  // Format data sections
  const dataSections = sections.map(formatPlanningSection);

  // Format context sections
  const contextParts = contextSections.map(cs => cs.content).filter(Boolean);

  // Build the prompt with ALL available context
  const prompt = `# Tomorrow's Plan Suggestions

## Task
Generate suggestions for tomorrow's daily plan: **${tomorrowDayName}, ${tomorrowStr}**

## Day Stage
Tomorrow is a **${stageInfo.name}** day.
Focus on: ${stageInfo.description}
When selecting priorities, prefer tasks tagged with ${stageInfo.tag}.

## Current Context
${contextParts.length > 0 ? contextParts.join('\n\n') : '(No context available)'}

## Available Data
${dataSections.join('\n\n')}

## Instructions
Based on the day's stage, current context (weather, etc.), and the data above, generate:

1. **Today's Focus**: A brief 1-2 sentence theme or intention for the day that aligns with the ${stageInfo.name} stage. Consider weather and any relevant context. What should be the main focus?

2. **Top Priorities**: A bulleted list (3-5 items) of the most important things to accomplish. Consider:
   - Events that require preparation or attendance
   - High-priority or overdue tasks
   - Open issues that need attention
   - Tasks that match the day's stage (${stageInfo.name})
   - Weather conditions that might affect plans

   Use Obsidian Tasks format with stage tags and created date:
   "- [ ] Task description ➕ ${tomorrowStr} ${stageInfo.tag}"

Format your response EXACTLY like this:
---
FOCUS: [1-2 sentence focus/theme for the day]

PRIORITIES:
- [ ] Priority 1 ➕ ${tomorrowStr} ${stageInfo.tag}
- [ ] Priority 2 ➕ ${tomorrowStr} ${stageInfo.tag}
- [ ] Priority 3 ➕ ${tomorrowStr} ${stageInfo.tag}
---

Keep it concise and actionable. Tasks should be specific and achievable.`;

  // Get model from config
  let model = 'claude-haiku-4-5-20251001';
  try {
    const configModel = execSync('bin/get-config ai.claude_model 2>/dev/null', { encoding: 'utf8' }).trim();
    if (configModel) model = configModel;
  } catch { /* use default */ }
  if (process.env.CLAUDE_MODEL) model = process.env.CLAUDE_MODEL;

  // Call API
  try {
    const tempPromptFile = `/tmp/tomorrow-prompt-${Date.now()}.txt`;
    fs.writeFileSync(tempPromptFile, prompt);

    const response = execSync(
      `npx dotenvx run --quiet -- node -e "const Anthropic = require('@anthropic-ai/sdk'); const fs = require('fs'); const client = new Anthropic({ apiKey: process.env.TODAY_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY }); (async () => { const prompt = fs.readFileSync('${tempPromptFile}', 'utf-8'); const response = await client.messages.create({ model: '${model}', max_tokens: 500, temperature: 0.7, messages: [{ role: 'user', content: prompt }] }); console.log(response.content[0].text.trim()); })();"`,
      { encoding: 'utf8', timeout: 30000 }
    );

    fs.unlinkSync(tempPromptFile);

    // Parse response
    const focusMatch = response.match(/FOCUS:\s*(.+?)(?:\n|$)/);
    const prioritiesMatch = response.match(/PRIORITIES:\s*([\s\S]*?)(?:---|$)/);

    return {
      focus: focusMatch ? focusMatch[1].trim() : null,
      priorities: prioritiesMatch ? prioritiesMatch[1].trim() : null,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Update tomorrow's plan file with AI suggestions
 */
function updateTomorrowPlan(filePath, suggestions) {
  if (!suggestions || (!suggestions.focus && !suggestions.priorities)) return false;

  let content = fs.readFileSync(filePath, 'utf-8');
  let modified = false;

  // Update TODAY_FOCUS section
  if (suggestions.focus) {
    const focusReplacement = `<!-- TODAY_FOCUS: Day theme and focus area -->\n## 🎯 Today's Focus\n\n${suggestions.focus}\n\n<!-- /TODAY_FOCUS -->`;
    const newContent = content.replace(
      /<!-- TODAY_FOCUS:.*?-->\s*## 🎯 Today's Focus\s*<!-- \/TODAY_FOCUS -->/s,
      focusReplacement
    );
    if (newContent !== content) {
      content = newContent;
      modified = true;
    }
  }

  // Update TOP_PRIORITIES section
  if (suggestions.priorities) {
    const prioritiesReplacement = `<!-- TOP_PRIORITIES: Auto-generated from database -->\n## 📋 Top Priorities\n\n${suggestions.priorities}\n\n<!-- /TOP_PRIORITIES -->`;
    const newContent = content.replace(
      /<!-- TOP_PRIORITIES:.*?-->\s*## 📋 Top Priorities\s*(?:\{\{PRIORITIES_FROM_DATABASE\}\})?\s*<!-- \/TOP_PRIORITIES -->/s,
      prioritiesReplacement
    );
    if (newContent !== content) {
      content = newContent;
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  return modified;
}

/**
 * Link today's plan to Obsidian's daily note
 * Reads daily-notes.json config to find the correct folder and format
 * Prepends a link to the plan file if not already present
 */
function linkPlanToDailyNote(planPath, date) {
  if (!linkDailyNotes) return { linked: false, reason: 'disabled' };

  const vaultPath = path.join(projectRoot, 'vault');
  const dailyNotesConfigPath = path.join(vaultPath, '.obsidian', 'daily-notes.json');

  // Check if daily-notes.json exists
  if (!fs.existsSync(dailyNotesConfigPath)) {
    return { linked: false, reason: 'no daily-notes config' };
  }

  let dailyNotesConfig;
  try {
    dailyNotesConfig = JSON.parse(fs.readFileSync(dailyNotesConfigPath, 'utf-8'));
  } catch {
    return { linked: false, reason: 'invalid daily-notes config' };
  }

  const folder = dailyNotesConfig.folder || '';
  // Default format is YYYY-MM-DD, but respect config if present
  const format = dailyNotesConfig.format || 'YYYY-MM-DD';

  // Build the daily note filename based on format
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  // Simple format substitution (covers common cases)
  let filename = format
    .replace('YYYY', year)
    .replace('MM', month)
    .replace('DD', day)
    .replace('M', date.getMonth() + 1)
    .replace('D', date.getDate());
  filename += '.md';

  const dailyNotePath = path.join(vaultPath, folder, filename);

  // Check if daily note exists
  if (!fs.existsSync(dailyNotePath)) {
    return { linked: false, reason: 'daily note not found', path: dailyNotePath };
  }

  // Read daily note content
  let content = fs.readFileSync(dailyNotePath, 'utf-8');

  // Build the link to the plan file (relative path within vault)
  const planRelPath = path.relative(vaultPath, planPath).replace(/\\/g, '/');
  const planBasename = path.basename(planPath, '.md');
  const planLink = `[[${planRelPath.replace('.md', '')}|📋 Today's Plan]]`;

  // Check if link already exists
  if (content.includes(planLink) || content.includes(`[[${planRelPath.replace('.md', '')}`)) {
    return { linked: false, reason: 'already linked' };
  }

  // Prepend link after frontmatter if present, otherwise at the top
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatterMatch) {
    const afterFrontmatter = frontmatterMatch[0].length;
    content = content.slice(0, afterFrontmatter) + '\n' + planLink + '\n' + content.slice(afterFrontmatter);
  } else {
    content = planLink + '\n\n' + content;
  }

  fs.writeFileSync(dailyNotePath, content, 'utf-8');
  return { linked: true, path: dailyNotePath };
}

/**
 * Main function
 */
async function main() {
  const today = new Date();
  const planPaths = getPlanFilePaths(today);
  const contextParts = [];
  const metadata = {
    plans_found: [],
    plans_missing: [],
    plans_created: [],
    summaries_generated: [],
    done_today_fixed: [],
    due_today_removed: [],
    empty_reflection_removed: [],
    summary_callouts_added: [],
    navigation_added: [],
    tomorrow_updated: false,
    daily_note_linked: null,
  };

  // Ensure today's daily plan exists
  const dailyResult = ensureDailyPlan(planPaths.day, today);
  if (dailyResult.created) {
    metadata.plans_created.push({ type: 'day', file: dailyResult.file });
  }

  // Link today's plan to Obsidian daily note
  const linkResult = linkPlanToDailyNote(planPaths.day.path, today);
  if (linkResult.linked) {
    metadata.daily_note_linked = path.basename(linkResult.path);
  }

  // Ensure tomorrow's daily plan exists
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowPaths = getPlanFilePaths(tomorrow);
  const tomorrowStr = formatDateStr(tomorrow);
  const tomorrowResult = ensureDailyPlan(tomorrowPaths.day, tomorrow);
  if (tomorrowResult.created) {
    metadata.plans_created.push({ type: 'day', file: tomorrowResult.file });
  }

  // Fix "done today" in past daily files
  const fixedFiles = fixDoneTodayInPastFiles(today, 7);
  if (fixedFiles.length > 0) {
    metadata.done_today_fixed = fixedFiles;
  }

  // Remove DUE_TODAY section from past daily files
  const removedDueToday = removeDueTodayFromPastFiles(today, 7);
  if (removedDueToday.length > 0) {
    metadata.due_today_removed = removedDueToday;
  }

  // Remove unedited Reflection section from past daily files
  const removedReflection = removeEmptyReflectionFromPastFiles(today, 7);
  if (removedReflection.length > 0) {
    metadata.empty_reflection_removed = removedReflection;
  }

  // Add Day Summary callout to past files that have summaries but are missing it
  const addedCallouts = addSummaryCalloutToPastFiles(today, 7);
  if (addedCallouts.length > 0) {
    metadata.summary_callouts_added = addedCallouts;
  }

  // Add navigation links to all plan files that are missing them
  const addedNavigation = addNavigationToAllFiles();
  if (addedNavigation.length > 0) {
    metadata.navigation_added = addedNavigation;
  }

  // Generate summaries for past days that are missing them
  const daysNeedingSummaries = getPastDaysNeedingSummaries(today, 7);
  for (const dayInfo of daysNeedingSummaries) {
    const summary = await generateDailySummary(dayInfo.dateStr, dayInfo.path);
    if (summary) {
      addSummaryToFile(dayInfo.path, summary);
      metadata.summaries_generated.push({
        file: dayInfo.filename,
        date: dayInfo.dateStr,
      });
    }
  }

  // Generate suggestions for tomorrow's plan if needed
  if (needsPriorities(tomorrowPaths.day.path)) {
    const suggestions = await generateTomorrowSuggestions(tomorrowStr, tomorrowPaths.day.path);
    if (suggestions && updateTomorrowPlan(tomorrowPaths.day.path, suggestions)) {
      metadata.tomorrow_updated = true;
    }
  }

  // Process each level of the hierarchy
  for (const [level, planInfo] of Object.entries(planPaths)) {
    if (fs.existsSync(planInfo.path)) {
      try {
        const content = fs.readFileSync(planInfo.path, 'utf-8');
        const formatted = formatPlanContext(planInfo, content);
        if (formatted.split('\n').length > 1) {
          contextParts.push(formatted);
        }
        metadata.plans_found.push({
          type: level,
          file: path.basename(planInfo.path),
        });
      } catch (error) {
        metadata.plans_missing.push({
          type: level,
          file: path.basename(planInfo.path),
          error: error.message,
        });
      }
    } else {
      metadata.plans_missing.push({
        type: level,
        file: path.basename(planInfo.path),
      });
    }
  }

  // Build context output
  let context = '';
  if (contextParts.length > 0) {
    context = `## Current Plan Hierarchy\n\n${contextParts.join('\n\n---\n\n')}`;
  } else {
    context = 'No plan files found for the current period.';
  }

  console.log(JSON.stringify({
    context,
    metadata,
  }));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
