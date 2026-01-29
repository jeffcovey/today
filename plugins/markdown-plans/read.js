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
import { createCompletion, isAIAvailable } from '../../src/ai-provider.js';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const contextOnly = process.env.CONTEXT_ONLY === 'true'; // Skip expensive AI operations

const plansDirectory = config.plans_directory || (process.env.VAULT_PATH ? `${process.env.VAULT_PATH}/plans` : 'vault/plans');
const templatesDirectory = config.templates_directory || (process.env.VAULT_PATH ? `${process.env.VAULT_PATH}/plans/templates` : 'vault/plans/templates');
const linkDailyNotes = config.link_daily_notes !== false; // opt-out, default true
const plansDir = path.isAbsolute(plansDirectory) ? plansDirectory : path.join(projectRoot, plansDirectory);
const templatesDir = path.isAbsolute(templatesDirectory) ? templatesDirectory : path.join(projectRoot, templatesDirectory);

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

  // YAML parser that handles key: value pairs and arrays
  const frontmatter = {};
  let pendingArrayKey = null;
  let currentArray = null;

  for (const line of yaml.split('\n')) {
    // Check for array item (indented with -)
    const arrayItemMatch = line.match(/^\s+-\s*(.*)$/);
    // Check for key with no inline value (potential array start)
    const emptyKeyMatch = line.match(/^(\w+):\s*$/);
    // Check for simple key: value
    const keyMatch = line.match(/^(\w+):\s*(.+)$/);

    if (arrayItemMatch) {
      // This is an array item
      if (pendingArrayKey && !currentArray) {
        // First array item - now we know it's actually an array
        currentArray = [];
        frontmatter[pendingArrayKey] = currentArray;
      }
      if (currentArray) {
        currentArray.push(arrayItemMatch[1]);
      }
    } else if (emptyKeyMatch) {
      // Key with no value - could be array start or empty value
      // Finalize any pending array key that had no items (it's empty string)
      if (pendingArrayKey && !currentArray) {
        frontmatter[pendingArrayKey] = '';
      }
      pendingArrayKey = emptyKeyMatch[1];
      currentArray = null;
    } else if (keyMatch) {
      // Simple key: value
      // Finalize any pending array key that had no items
      if (pendingArrayKey && !currentArray) {
        frontmatter[pendingArrayKey] = '';
      }
      frontmatter[keyMatch[1]] = keyMatch[2].trim().replace(/^"(.*)"$/, '$1');
      pendingArrayKey = null;
      currentArray = null;
    }
  }

  // Handle trailing pending key with no items
  if (pendingArrayKey && !currentArray) {
    frontmatter[pendingArrayKey] = '';
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

  // Map plan types to their frontmatter field prefixes
  const typeToPrefix = {
    year: 'year',
    quarter: 'quarter',
    month: 'month',
    week: 'week',
    day: 'daily',
  };
  const prefix = typeToPrefix[planInfo.type] || planInfo.type;

  // Add theme from frontmatter if available
  const themeKey = `${prefix}_theme`;
  if (frontmatter[themeKey]) {
    lines.push('');
    lines.push(`**Theme:** ${frontmatter[themeKey]}`);
  }

  // Add goals/priorities from frontmatter if available
  const goalsKey = planInfo.type === 'week' ? 'week_priorities' : `${prefix}_goals`;
  const goals = frontmatter[goalsKey];
  if (goals && Array.isArray(goals) && goals.length > 0) {
    lines.push('');
    lines.push(`**${planInfo.type === 'week' ? 'Priorities' : 'Goals'}:**`);
    for (const goal of goals) {
      lines.push(`- ${goal}`);
    }
  }

  // Add summary if available
  const summaryKey = `${prefix === 'daily' ? 'daily' : prefix + 'ly'}_summary`;
  const summary = frontmatter[summaryKey];
  if (summary && typeof summary === 'string' && summary.trim()) {
    lines.push('');
    lines.push(`**Summary:** ${summary}`);
  }

  // Add key sections from body based on plan type
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
 * Get template variables for a weekly plan
 */
function getWeeklyTemplateVariables(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const week = getISOWeek(date);
  const quarter = getQuarter(month);
  const monthName = date.toLocaleDateString('en-US', { month: 'long' });

  // Get start of week (Monday)
  const startOfWeek = new Date(date);
  const dayOfWeek = date.getDay();
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert Sunday (0) to 6
  startOfWeek.setDate(date.getDate() - daysToSubtract);

  // Generate all days of the week
  const days = [];
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const stagePattern = ['Front', 'Off', 'Front', 'Back', 'Off', 'Front', 'Back']; // Mon, Tue, Wed, Thu, Fri, Sat, Sun

  for (let i = 0; i < 7; i++) {
    const day = new Date(startOfWeek);
    day.setDate(startOfWeek.getDate() + i);
    days.push({
      name: dayNames[i],
      date: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      stage: stagePattern[i] + ' Stage',
    });
  }

  // Calculate previous and next week filenames
  const prevWeek = new Date(startOfWeek);
  prevWeek.setDate(startOfWeek.getDate() - 7);
  const nextWeek = new Date(startOfWeek);
  nextWeek.setDate(startOfWeek.getDate() + 7);

  const prevWeekPaths = getPlanFilePaths(prevWeek);
  const nextWeekPaths = getPlanFilePaths(nextWeek);
  const prevWeekFile = path.basename(prevWeekPaths.week.path, '.md');
  const nextWeekFile = path.basename(nextWeekPaths.week.path, '.md');

  // End date (Sunday)
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);

  // Build smart date range that handles month/year transitions
  const endMonthName = endOfWeek.toLocaleDateString('en-US', { month: 'long' });
  const endYear = endOfWeek.getFullYear();
  let dateRange;
  let yearSuffix;
  if (startOfWeek.getMonth() === endOfWeek.getMonth()) {
    // Same month: "December 15-21, 2025"
    dateRange = `${monthName} ${startOfWeek.getDate()}-${endOfWeek.getDate()}`;
    yearSuffix = `, ${year}`;
  } else if (year === endYear) {
    // Different months, same year: "December 29 - January 4, 2025"
    dateRange = `${monthName} ${startOfWeek.getDate()} - ${endMonthName} ${endOfWeek.getDate()}`;
    yearSuffix = `, ${year}`;
  } else {
    // Different years: "December 29, 2025 - January 4, 2026" (no suffix needed)
    dateRange = `${monthName} ${startOfWeek.getDate()}, ${year} - ${endMonthName} ${endOfWeek.getDate()}, ${endYear}`;
    yearSuffix = '';
  }

  return {
    '{{WEEK_NUMBER}}': String(week),
    '{{START_DATE}}': startOfWeek.toISOString().split('T')[0],
    '{{END_DATE}}': endOfWeek.toISOString().split('T')[0],
    '{{START_DAY}}': String(startOfWeek.getDate()),
    '{{END_DAY}}': String(endOfWeek.getDate()),
    '{{DATE_RANGE}}': dateRange,
    '{{YEAR_SUFFIX}}': yearSuffix,
    '{{YEAR}}': String(year),
    '{{MONTH}}': String(month),
    '{{MONTH_NAME}}': monthName,
    '{{QUARTER}}': `Q${quarter}`,
    '{{PREV_WEEK}}': prevWeekFile,
    '{{NEXT_WEEK}}': nextWeekFile,
    '{{DATE}}': new Date().toISOString().split('T')[0],

    // Individual day template variables
    '{{MON_DATE}}': days[0].date,
    '{{TUE_DATE}}': days[1].date,
    '{{WED_DATE}}': days[2].date,
    '{{THU_DATE}}': days[3].date,
    '{{FRI_DATE}}': days[4].date,
    '{{SAT_DATE}}': days[5].date,
    '{{SUN_DATE}}': days[6].date,

    // Stage assignments for each day
    '{{MON_STAGE}}': days[0].stage,
    '{{TUE_STAGE}}': days[1].stage,
    '{{WED_STAGE}}': days[2].stage,
    '{{THU_STAGE}}': days[3].stage,
    '{{FRI_STAGE}}': days[4].stage,
    '{{SAT_STAGE}}': days[5].stage,
    '{{SUN_STAGE}}': days[6].stage,
  };
}

/**
 * Get template variables for a monthly plan
 */
function getMonthlyTemplateVariables(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const quarter = getQuarter(month);
  const monthName = date.toLocaleDateString('en-US', { month: 'long' });

  // First day of the month
  const startOfMonth = new Date(year, month - 1, 1);
  // Last day of the month
  const endOfMonth = new Date(year, month, 0);

  return {
    '{{YEAR}}': String(year),
    '{{MONTH}}': String(month).padStart(2, '0'),
    '{{MONTH_NAME}}': monthName,
    '{{QUARTER}}': `Q${quarter}`,
    '{{START_DATE}}': formatDateStr(startOfMonth),
    '{{END_DATE}}': formatDateStr(endOfMonth),
  };
}

/**
 * Get template variables for a quarterly plan
 */
function getQuarterlyTemplateVariables(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const quarter = getQuarter(month);

  // First month of the quarter
  const firstMonth = (quarter - 1) * 3 + 1;
  const startOfQuarter = new Date(year, firstMonth - 1, 1);
  // Last day of the quarter
  const endOfQuarter = new Date(year, firstMonth + 2, 0);

  // Get month names for the quarter
  const monthNames = [];
  for (let m = firstMonth; m < firstMonth + 3; m++) {
    const d = new Date(year, m - 1, 1);
    monthNames.push(d.toLocaleDateString('en-US', { month: 'long' }));
  }

  return {
    '{{YEAR}}': String(year),
    '{{QUARTER}}': `Q${quarter}`,
    '{{QUARTER_NUM}}': String(quarter),
    '{{START_DATE}}': formatDateStr(startOfQuarter),
    '{{END_DATE}}': formatDateStr(endOfQuarter),
    '{{QUARTER_MONTHS}}': monthNames.join(', '),
  };
}

/**
 * Get template variables for a yearly plan
 */
function getYearlyTemplateVariables(date) {
  const year = date.getFullYear();

  const startOfYear = new Date(year, 0, 1);
  const endOfYear = new Date(year, 11, 31);

  return {
    '{{YEAR}}': String(year),
    '{{START_DATE}}': formatDateStr(startOfYear),
    '{{END_DATE}}': formatDateStr(endOfYear),
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
 * Create a weekly plan from template if it doesn't exist
 */
function ensureWeeklyPlan(planInfo, date) {
  if (fs.existsSync(planInfo.path)) {
    return { existed: true };
  }

  const templatePath = path.join(templatesDir, 'weekly-plan.md');
  if (!fs.existsSync(templatePath)) {
    return { error: `Template not found: ${templatePath}` };
  }

  const template = fs.readFileSync(templatePath, 'utf-8');
  const variables = getWeeklyTemplateVariables(date);

  let content = template;
  for (const [key, value] of Object.entries(variables)) {
    content = content.split(key).join(value);
  }

  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(planInfo.path, content, 'utf-8');

  return { created: true, file: path.basename(planInfo.path) };
}

/**
 * Create a monthly plan from template if it doesn't exist
 */
function ensureMonthlyPlan(planInfo, date) {
  if (fs.existsSync(planInfo.path)) {
    return { existed: true };
  }

  const templatePath = path.join(templatesDir, 'monthly-plan.md');
  if (!fs.existsSync(templatePath)) {
    return { error: `Template not found: ${templatePath}` };
  }

  const template = fs.readFileSync(templatePath, 'utf-8');
  const variables = getMonthlyTemplateVariables(date);

  let content = template;
  for (const [key, value] of Object.entries(variables)) {
    content = content.split(key).join(value);
  }

  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(planInfo.path, content, 'utf-8');

  return { created: true, file: path.basename(planInfo.path) };
}

/**
 * Create a quarterly plan from template if it doesn't exist
 */
function ensureQuarterlyPlan(planInfo, date) {
  if (fs.existsSync(planInfo.path)) {
    return { existed: true };
  }

  const templatePath = path.join(templatesDir, 'quarterly-plan.md');
  if (!fs.existsSync(templatePath)) {
    return { error: `Template not found: ${templatePath}` };
  }

  const template = fs.readFileSync(templatePath, 'utf-8');
  const variables = getQuarterlyTemplateVariables(date);

  let content = template;
  for (const [key, value] of Object.entries(variables)) {
    content = content.split(key).join(value);
  }

  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(planInfo.path, content, 'utf-8');

  return { created: true, file: path.basename(planInfo.path) };
}

/**
 * Create a yearly plan from template if it doesn't exist
 */
function ensureYearlyPlan(planInfo, date) {
  if (fs.existsSync(planInfo.path)) {
    return { existed: true };
  }

  const templatePath = path.join(templatesDir, 'yearly-plan.md');
  if (!fs.existsSync(templatePath)) {
    return { error: `Template not found: ${templatePath}` };
  }

  const template = fs.readFileSync(templatePath, 'utf-8');
  const variables = getYearlyTemplateVariables(date);

  let content = template;
  for (const [key, value] of Object.entries(variables)) {
    content = content.split(key).join(value);
  }

  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(planInfo.path, content, 'utf-8');

  return { created: true, file: path.basename(planInfo.path) };
}

/**
 * Extract date components from plan filename for sorting
 * Pattern: YYYY_Q#_MM_W##_DD.md → { year, month, week, day }
 * Week plans end in _00.md
 */
function parsePlanFilename(filename) {
  // Daily plan: 2025_Q4_12_W01_29.md
  const dailyMatch = filename.match(/^(\d{4})_Q\d+_(\d{2})_W(\d+)_(\d{2})\.md$/);
  if (dailyMatch) {
    return {
      year: parseInt(dailyMatch[1], 10),
      month: parseInt(dailyMatch[2], 10),
      week: parseInt(dailyMatch[3], 10),
      day: parseInt(dailyMatch[4], 10),
      isDaily: true,
    };
  }

  // Week plan: 2025_Q4_12_W01_00.md
  const weekMatch = filename.match(/^(\d{4})_Q\d+_(\d{2})_W(\d+)_00\.md$/);
  if (weekMatch) {
    return {
      year: parseInt(weekMatch[1], 10),
      month: parseInt(weekMatch[2], 10),
      week: parseInt(weekMatch[3], 10),
      day: 0,
      isWeekly: true,
    };
  }

  // Month plan: 2025_Q4_12_00.md
  const monthMatch = filename.match(/^(\d{4})_Q\d+_(\d{2})_00\.md$/);
  if (monthMatch) {
    return {
      year: parseInt(monthMatch[1], 10),
      month: parseInt(monthMatch[2], 10),
      day: 0,
      isMonthly: true,
    };
  }

  // Quarter plan: 2025_Q4_00.md
  const quarterMatch = filename.match(/^(\d{4})_Q(\d+)_00\.md$/);
  if (quarterMatch) {
    return {
      year: parseInt(quarterMatch[1], 10),
      quarter: parseInt(quarterMatch[2], 10),
      month: 0,
      day: 0,
      isQuarterly: true,
    };
  }

  // Year plan: 2025_00.md
  const yearMatch = filename.match(/^(\d{4})_00\.md$/);
  if (yearMatch) {
    return {
      year: parseInt(yearMatch[1], 10),
      month: 0,
      day: 0,
      isYearly: true,
    };
  }

  return null;
}

/**
 * Get all plan files sorted chronologically by actual date
 * Sorts by year, month, week, day to handle ISO week boundary issues
 */
function getSortedPlanFiles() {
  if (!fs.existsSync(plansDir)) return [];

  const files = fs.readdirSync(plansDir)
    .filter(f => f.endsWith('.md') && /^\d{4}_/.test(f));

  // Sort by actual date components, not alphabetically
  files.sort((a, b) => {
    const parsedA = parsePlanFilename(a);
    const parsedB = parsePlanFilename(b);

    // If we can't parse, fall back to alphabetical
    if (!parsedA || !parsedB) return a.localeCompare(b);

    // Sort by year first
    if (parsedA.year !== parsedB.year) return parsedA.year - parsedB.year;

    // Then by month (0 for yearly/quarterly plans goes first)
    if (parsedA.month !== parsedB.month) return parsedA.month - parsedB.month;

    // Then by week (0 for monthly plans, then by week number)
    const weekA = parsedA.week || 0;
    const weekB = parsedB.week || 0;
    if (weekA !== weekB) return weekA - weekB;

    // Then by day (0 for weekly plans goes first)
    if (parsedA.day !== parsedB.day) return parsedA.day - parsedB.day;

    // Fall back to alphabetical for same date
    return a.localeCompare(b);
  });

  return files;
}

/**
 * Migrate a plan file from hardcoded navigation to widget-based navigation
 * - Removes old [[plans/...|← Previous]] style navigation
 * - Adds dataviewjs navigation widget if not present
 */
function migrateNavigationToWidget(filePath) {
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;

  // Check if already has navigation widget
  const hasWidget = content.includes('type: "navigation"');
  if (hasWidget) {
    // Just remove old hardcoded navigation if present
    const navLinePattern = /^.*\[\[plans\/[^\]]+\|(← Previous|Next →|↑ Up)\]\].*\n?/gm;
    content = content.replace(navLinePattern, '');
    content = content.replace(/\n{3,}/g, '\n\n');

    if (content !== originalContent) {
      fs.writeFileSync(filePath, content, 'utf-8');
      return true;
    }
    return false;
  }

  // Remove old hardcoded navigation lines
  const navLinePattern = /^.*\[\[plans\/[^\]]+\|(← Previous|Next →|↑ Up)\]\].*\n?/gm;
  content = content.replace(navLinePattern, '');

  // Add navigation widget after the main header
  const headerMatch = content.match(/^(# .+)$/m);
  if (headerMatch) {
    const headerLine = headerMatch[1];
    const navWidget = '```dataviewjs\nawait dv.view("scripts/weekly-widget", { type: "navigation" });\n```\n';
    content = content.replace(
      headerLine,
      `${headerLine}\n\n${navWidget}`
    );
  }

  // Clean up multiple blank lines
  content = content.replace(/\n{3,}/g, '\n\n');

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Migrate all plan files to use widget-based navigation
 */
function migrateAllNavigationToWidget() {
  const migrated = [];
  const files = getSortedPlanFiles();

  for (const file of files) {
    const filePath = path.join(plansDir, file);
    if (migrateNavigationToWidget(filePath)) {
      migrated.push({ file });
    }
  }

  return migrated;
}

/**
 * Generate AI summary for a specific date
 * Uses bin/today dry-run --date to get the full context for that date
 */
async function generateDailySummary(dateStr, planFilePath) {
  // Check if AI is available
  if (!(await isAIAvailable())) {
    return null;
  }

  // Get data context using bin/today dry-run --date
  let dataContext = '';
  try {
    dataContext = execSync(`bin/today dry-run --date ${dateStr} --no-sync --quiet 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 30000
    }).trim();
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

  // Call AI provider
  try {
    const response = await createCompletion({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 300,
      temperature: 0.7,
    });
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
      // Use SUBSTR to extract local date from timezone-aware timestamps (SQLite's date() converts to UTC)
      query = `SELECT ${columns.join(', ')} FROM ${tableName} WHERE SUBSTR(start_time, 1, 10) >= date('${targetDateStr}', '-1 day') ORDER BY start_time DESC LIMIT 10`;
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
  // Check if AI is available
  if (!(await isAIAvailable())) {
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

  // Call AI provider
  try {
    const response = await createCompletion({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 500,
      temperature: 0.7,
    });

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

  // Skip if markdown-diary plugin is enabled (it handles richer daily note content)
  const diaryPluginPath = path.join(projectRoot, 'plugins', 'markdown-diary', 'plugin.toml');
  if (fs.existsSync(diaryPluginPath)) {
    return { linked: false, reason: 'markdown-diary plugin handles daily notes' };
  }

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

  // Build the link to the plan file (relative path within vault)
  const planRelPath = path.relative(vaultPath, planPath).replace(/\\/g, '/');
  const planBasename = path.basename(planPath, '.md');
  const planLink = `[[${planRelPath.replace('.md', '')}|📋 Today's Plan]]`;
  const planLinkPrefix = `[[${planRelPath.replace('.md', '')}`;

  // Re-read file immediately before modification to get freshest content.
  // This minimizes race conditions when multiple deployments sync simultaneously.
  let content = fs.readFileSync(dailyNotePath, 'utf-8');

  // Check if link already exists (on fresh content)
  if (content.includes(planLink) || content.includes(planLinkPrefix)) {
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

  // Write immediately after read-modify
  fs.writeFileSync(dailyNotePath, content, 'utf-8');
  return { linked: true, path: dailyNotePath };
}

/**
 * Query diary entries from database for a date range
 * Returns entries grouped by type: { gratitude: [], progress: [], concern: [] }
 */
function getDiaryEntriesForWeek(startDate, endDate) {
  const dbPath = path.join(projectRoot, '.data/today.db');
  if (!fs.existsSync(dbPath)) {
    return { gratitude: [], progress: [], concern: [] };
  }

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);

  // Query diary entries within the date range
  const query = `SELECT id, date, text, metadata FROM diary WHERE date >= '${startStr}' AND date < '${endStr}T23:59:59' ORDER BY date ASC`;

  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${query}"`, { encoding: 'utf8' });
    const rows = JSON.parse(result || '[]');

    // Group by type
    const grouped = { gratitude: [], progress: [], concern: [] };
    for (const row of rows) {
      let type = 'journal';
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          type = meta.type || 'journal';
        } catch { /* ignore */ }
      }
      if (grouped[type]) {
        grouped[type].push({
          id: row.id,
          date: row.date,
          text: row.text,
        });
      }
    }
    return grouped;
  } catch {
    return { gratitude: [], progress: [], concern: [] };
  }
}

/**
 * Format diary entries for display in weekly plan
 */
function formatDiaryEntries(entries, type) {
  if (entries.length === 0) return null;

  const lines = [];
  for (const entry of entries) {
    // Extract just the date part for display
    const dateStr = entry.date.substring(0, 10);
    const timeStr = entry.date.substring(11, 16);
    const dateLabel = timeStr && timeStr !== '00:00' ? `${dateStr} ${timeStr}` : dateStr;

    // Clean up the text (remove "I'm grateful for " prefix if present for gratitude)
    let text = entry.text.split('\n').map(l => l.trim()).join('\n').trim();
    if (type === 'gratitude' && text.toLowerCase().startsWith("i'm grateful for ")) {
      text = text.substring(17);
    }

    // Format as bullet with date
    lines.push(`- **${dateLabel}**: ${text}`);
  }
  return lines.join('\n');
}

/**
 * Parse existing diary entries from the markdown section
 * Returns entries grouped by type (gratitude, progress, concern)
 */
function parseExistingDiaryEntries(sectionContent) {
  const existing = { gratitude: new Set(), progress: new Set(), concern: new Set() };

  // Find each subsection and extract entries
  const sections = sectionContent.split(/###\s+/);
  for (const section of sections) {
    const lines = section.trim().split('\n');
    if (lines.length === 0) continue;

    const header = lines[0].toLowerCase().trim();
    let type = null;
    if (header.includes('gratitude')) type = 'gratitude';
    else if (header.includes('progress')) type = 'progress';
    else if (header.includes('concern')) type = 'concern';

    if (type) {
      // Extract bullet entries - handle multi-line entries
      // An entry starts with "- **date**: text" and continues until the next "- **" or end
      let currentDate = null;
      let currentTextLines = [];

      const saveCurrentEntry = () => {
        if (currentDate && currentTextLines.length > 0) {
          const fullText = currentTextLines.join('\n').trim();
          existing[type].add(`${currentDate}|${fullText}`);
        }
        currentDate = null;
        currentTextLines = [];
      };

      for (const line of lines.slice(1)) {
        const match = line.match(/^-\s+\*\*([^*]+)\*\*:\s*(.*)$/);
        if (match) {
          // New entry starting - save previous one first
          saveCurrentEntry();
          currentDate = match[1].trim();
          if (match[2].trim()) {
            currentTextLines.push(match[2].trim());
          }
        } else if (currentDate && line.trim()) {
          // Continuation line of current entry
          // Strip leading "- " if present (it's part of the text content)
          const continuationText = line.replace(/^-\s*/, '- ').trim();
          currentTextLines.push(continuationText);
        }
      }
      // Don't forget the last entry
      saveCurrentEntry();
    }
  }

  return existing;
}

/**
 * Update weekly plan file with diary notes from database
 * Uses markers to identify the section: <!-- DIARY_NOTES:START --> ... <!-- DIARY_NOTES:END -->
 * Merges new entries with existing ones instead of replacing
 */
function updateWeeklyPlanWithDiaryNotes(weeklyPlanPath, startDate, endDate) {
  if (!fs.existsSync(weeklyPlanPath)) {
    return { updated: false, reason: 'file not found' };
  }

  const entries = getDiaryEntriesForWeek(startDate, endDate);
  const totalEntries = entries.gratitude.length + entries.progress.length + entries.concern.length;

  if (totalEntries === 0) {
    return { updated: false, reason: 'no diary entries', counts: { gratitude: 0, progress: 0, concern: 0 } };
  }

  let content = fs.readFileSync(weeklyPlanPath, 'utf-8');
  const startMarker = '<!-- DIARY_NOTES:START -->';
  const endMarker = '<!-- DIARY_NOTES:END -->';

  // Check if markers already exist and parse existing entries
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);
  let existingEntries = { gratitude: new Set(), progress: new Set(), concern: new Set() };

  if (startIndex !== -1 && endIndex !== -1) {
    const existingSection = content.substring(startIndex + startMarker.length, endIndex);
    existingEntries = parseExistingDiaryEntries(existingSection);
  }

  // Helper to check if entry already exists
  const entryExists = (type, dateLabel, text) => {
    return existingEntries[type].has(`${dateLabel}|${text}`);
  };

  // Helper to format entry and check if new
  const formatEntryWithCheck = (entry, type) => {
    const dateStr = entry.date.substring(0, 10);
    const timeStr = entry.date.substring(11, 16);
    const dateLabel = timeStr && timeStr !== '00:00' ? `${dateStr} ${timeStr}` : dateStr;

    let text = entry.text.split('\n').map(l => l.trim()).join('\n').trim();
    if (type === 'gratitude' && text.toLowerCase().startsWith("i'm grateful for ")) {
      text = text.substring(17);
    }

    // Check if this exact entry already exists
    if (entryExists(type, dateLabel, text)) {
      return null; // Skip existing entries
    }

    return `- **${dateLabel}**: ${text}`;
  };

  // Build new entries lists (only entries not already present)
  const newGratitude = entries.gratitude.map(e => formatEntryWithCheck(e, 'gratitude')).filter(Boolean);
  const newProgress = entries.progress.map(e => formatEntryWithCheck(e, 'progress')).filter(Boolean);
  const newConcern = entries.concern.map(e => formatEntryWithCheck(e, 'concern')).filter(Boolean);

  const totalNew = newGratitude.length + newProgress.length + newConcern.length;

  if (totalNew === 0) {
    return { updated: false, reason: 'no new entries', counts: { gratitude: 0, progress: 0, concern: 0 } };
  }

  // If section exists, append new entries to each subsection
  if (startIndex !== -1 && endIndex !== -1) {
    let existingSection = content.substring(startIndex, endIndex + endMarker.length);

    // Append to each subsection if there are new entries
    if (newGratitude.length > 0) {
      if (existingSection.includes('### Gratitude')) {
        // Find end of Gratitude section (next ### or end marker)
        existingSection = existingSection.replace(
          /(### Gratitude\n\n[\s\S]*?)(\n\n###|\n<!-- DIARY)/,
          `$1\n${newGratitude.join('\n')}$2`
        );
      } else {
        // Add new Gratitude section after the header
        existingSection = existingSection.replace(
          '## 📝 Week Notes\n\n',
          `## 📝 Week Notes\n\n### Gratitude\n\n${newGratitude.join('\n')}\n\n`
        );
      }
    }

    if (newProgress.length > 0) {
      if (existingSection.includes('### Progress')) {
        existingSection = existingSection.replace(
          /(### Progress\n\n[\s\S]*?)(\n\n###|\n<!-- DIARY)/,
          `$1\n${newProgress.join('\n')}$2`
        );
      } else {
        // Add before Concerns or end marker
        if (existingSection.includes('### Concerns')) {
          existingSection = existingSection.replace(
            '### Concerns',
            `### Progress\n\n${newProgress.join('\n')}\n\n### Concerns`
          );
        } else {
          existingSection = existingSection.replace(
            endMarker,
            `### Progress\n\n${newProgress.join('\n')}\n${endMarker}`
          );
        }
      }
    }

    if (newConcern.length > 0) {
      if (existingSection.includes('### Concerns')) {
        existingSection = existingSection.replace(
          /(### Concerns\n\n[\s\S]*?)(\n<!-- DIARY)/,
          `$1\n${newConcern.join('\n')}$2`
        );
      } else {
        existingSection = existingSection.replace(
          endMarker,
          `### Concerns\n\n${newConcern.join('\n')}\n${endMarker}`
        );
      }
    }

    const before = content.substring(0, startIndex);
    const after = content.substring(endIndex + endMarker.length);
    content = before + existingSection + after;
  } else {
    // No existing section - create new one with all entries
    const sections = [];

    const allGratitude = entries.gratitude.map(e => formatEntryWithCheck(e, 'gratitude') || formatDiaryEntries([e], 'gratitude').split('\n')[0]).filter(Boolean);
    const allProgress = entries.progress.map(e => formatEntryWithCheck(e, 'progress') || formatDiaryEntries([e], 'progress').split('\n')[0]).filter(Boolean);
    const allConcern = entries.concern.map(e => formatEntryWithCheck(e, 'concern') || formatDiaryEntries([e], 'concern').split('\n')[0]).filter(Boolean);

    if (allGratitude.length > 0) sections.push(`### Gratitude\n\n${allGratitude.join('\n')}`);
    if (allProgress.length > 0) sections.push(`### Progress\n\n${allProgress.join('\n')}`);
    if (allConcern.length > 0) sections.push(`### Concerns\n\n${allConcern.join('\n')}`);

    const diarySection = sections.join('\n\n');
    const newSection = `${startMarker}\n## 📝 Week Notes\n\n${diarySection}\n${endMarker}`;

    // Add new section before the Review section or at the end
    const reviewMatch = content.match(/## 🔍 Review/);
    if (reviewMatch && reviewMatch.index !== undefined) {
      content = content.substring(0, reviewMatch.index) + newSection + '\n\n---\n\n' + content.substring(reviewMatch.index);
    } else {
      const footerMatch = content.match(/\n\*Week \d+ of \d+/);
      if (footerMatch && footerMatch.index !== undefined) {
        content = content.substring(0, footerMatch.index) + '\n' + newSection + '\n' + content.substring(footerMatch.index);
      } else {
        content += '\n\n' + newSection;
      }
    }
  }

  fs.writeFileSync(weeklyPlanPath, content, 'utf-8');

  return {
    updated: true,
    counts: {
      gratitude: newGratitude.length,
      progress: newProgress.length,
      concern: newConcern.length,
    },
  };
}

/**
 * Get the Monday of the week for a given date
 */
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

/**
 * Find the earliest daily plan file date
 */
function getEarliestPlanDate() {
  if (!fs.existsSync(plansDir)) return null;

  const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
  const dailyFiles = files.filter(f => /^\d{4}_Q\d+_\d{2}_W\d+_\d{2}\.md$/.test(f) && !f.endsWith('_00.md'));

  let earliest = null;
  for (const f of dailyFiles) {
    const match = f.match(/^(\d{4})_Q\d+_(\d{2})_W\d+_(\d{2})\.md$/);
    if (match) {
      const d = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
      if (!earliest || d < earliest) earliest = d;
    }
  }
  return earliest;
}

/**
 * Create all missing weekly plan files from earliest plan date to today
 */
function createMissingWeeklyPlans(today) {
  const earliest = getEarliestPlanDate();
  if (!earliest) return { created: [], skipped: 0 };

  const created = [];
  let skipped = 0;

  // Start from the Monday of the earliest date
  let currentMonday = getMonday(earliest);
  const todayMonday = getMonday(today);

  while (currentMonday <= todayMonday) {
    const planPaths = getPlanFilePaths(currentMonday);

    if (!fs.existsSync(planPaths.week.path)) {
      const result = ensureWeeklyPlan(planPaths.week, currentMonday);
      if (result.created) {
        created.push(result.file);
      } else if (result.error) {
        skipped++;
      }
    }

    // Move to next week
    currentMonday.setDate(currentMonday.getDate() + 7);
  }

  return { created, skipped };
}

/**
 * Get week start and end dates from a weekly plan file's frontmatter
 */
function getWeekDatesFromPlan(weeklyPlanPath) {
  if (!fs.existsSync(weeklyPlanPath)) return null;

  const content = fs.readFileSync(weeklyPlanPath, 'utf-8');
  const { frontmatter } = parseFrontmatter(content);

  if (!frontmatter.start_date) return null;

  const startDate = new Date(frontmatter.start_date + 'T00:00:00');
  let endDate;

  if (frontmatter.end_date) {
    endDate = new Date(frontmatter.end_date + 'T23:59:59');
  } else {
    // Default to 6 days after start (Monday to Sunday)
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    endDate.setHours(23, 59, 59);
  }

  return { startDate, endDate };
}

/**
 * Query habit stats from database for a date range
 * Returns { total, completed, byCategory, byHabit }
 */
function getHabitStatsForWeek(startDate, endDate) {
  const dbPath = path.join(projectRoot, '.data/today.db');
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);

  // Query habit stats grouped by category
  const categoryQuery = `
    SELECT
      category,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) as partial
    FROM habits
    WHERE date >= '${startStr}' AND date <= '${endStr}'
    GROUP BY category
    ORDER BY category
  `;

  // Query individual habit stats
  const habitQuery = `
    SELECT
      title,
      category,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM habits
    WHERE date >= '${startStr}' AND date <= '${endStr}'
    GROUP BY title, category
    ORDER BY category, title
  `;

  try {
    const categoryResult = execSync(`sqlite3 -json "${dbPath}" "${categoryQuery}"`, { encoding: 'utf8' });
    const categoryRows = JSON.parse(categoryResult || '[]');

    if (categoryRows.length === 0) return null;

    const habitResult = execSync(`sqlite3 -json "${dbPath}" "${habitQuery}"`, { encoding: 'utf8' });
    const habitRows = JSON.parse(habitResult || '[]');

    // Aggregate totals
    let total = 0;
    let completed = 0;
    let skipped = 0;
    let partial = 0;
    const byCategory = {};

    for (const row of categoryRows) {
      total += row.total;
      completed += row.completed;
      skipped += row.skipped;
      partial += row.partial;

      const cat = row.category || 'Uncategorized';
      byCategory[cat] = {
        total: row.total,
        completed: row.completed,
        skipped: row.skipped,
        partial: row.partial,
        rate: row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0,
      };
    }

    // Process individual habits grouped by category
    const byHabit = {};
    for (const row of habitRows) {
      const cat = row.category || 'Uncategorized';
      if (!byHabit[cat]) byHabit[cat] = [];
      byHabit[cat].push({
        title: row.title,
        total: row.total,
        completed: row.completed,
        rate: row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0,
      });
    }

    return {
      total,
      completed,
      skipped,
      partial,
      rate: total > 0 ? Math.round((completed / total) * 100) : 0,
      byCategory,
      byHabit,
    };
  } catch {
    return null;
  }
}

/**
 * Format habit stats for display in weekly plan
 */
function formatHabitStats(stats) {
  if (!stats || stats.total === 0) return null;

  const lines = [];
  lines.push(`**Overall:** ${stats.completed}/${stats.total} completed (${stats.rate}%)`);

  // Show individual habits grouped by category
  if (stats.byHabit && Object.keys(stats.byHabit).length > 0) {
    for (const [category, habits] of Object.entries(stats.byHabit)) {
      const catStats = stats.byCategory[category];
      lines.push('');
      lines.push(`**${category}** (${catStats.rate}%):`);
      for (const habit of habits) {
        const emoji = habit.rate === 100 ? '✅' : habit.rate >= 50 ? '🔶' : '❌';
        lines.push(`- ${emoji} ${habit.title}: ${habit.completed}/${habit.total} (${habit.rate}%)`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Update weekly plan file with habit stats from database
 * Uses markers: <!-- HABIT_STATS:START --> ... <!-- HABIT_STATS:END -->
 */
function updateWeeklyPlanWithHabitStats(weeklyPlanPath, startDate, endDate) {
  if (!fs.existsSync(weeklyPlanPath)) {
    return { updated: false, reason: 'file not found' };
  }

  const stats = getHabitStatsForWeek(startDate, endDate);

  if (!stats || stats.total === 0) {
    return { updated: false, reason: 'no habit data', stats: null };
  }

  let content = fs.readFileSync(weeklyPlanPath, 'utf-8');

  const formattedStats = formatHabitStats(stats);
  const startMarker = '<!-- HABIT_STATS:START -->';
  const endMarker = '<!-- HABIT_STATS:END -->';
  const newSection = `${startMarker}\n### Habit Completion\n\n${formattedStats}\n${endMarker}`;

  // Check if markers already exist
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1) {
    // Replace existing section
    const before = content.substring(0, startIndex);
    const after = content.substring(endIndex + endMarker.length);
    content = before + newSection + after;
  } else {
    // Add after DIARY_NOTES section if present, otherwise before Review section
    const diaryEndMarker = '<!-- DIARY_NOTES:END -->';
    const diaryEndIndex = content.indexOf(diaryEndMarker);

    if (diaryEndIndex !== -1) {
      // Insert after diary notes
      const insertPoint = diaryEndIndex + diaryEndMarker.length;
      content = content.substring(0, insertPoint) + '\n\n' + newSection + content.substring(insertPoint);
    } else {
      // Add before the Review section
      const reviewMatch = content.match(/## 🔍 Review/);
      if (reviewMatch && reviewMatch.index !== undefined) {
        content = content.substring(0, reviewMatch.index) + newSection + '\n\n---\n\n' + content.substring(reviewMatch.index);
      } else {
        // Add before footer
        const footerMatch = content.match(/\n\*Week \d+ of \d+/);
        if (footerMatch && footerMatch.index !== undefined) {
          content = content.substring(0, footerMatch.index) + '\n' + newSection + '\n' + content.substring(footerMatch.index);
        } else {
          content += '\n\n' + newSection;
        }
      }
    }
  }

  fs.writeFileSync(weeklyPlanPath, content, 'utf-8');

  return {
    updated: true,
    stats: {
      total: stats.total,
      completed: stats.completed,
      rate: stats.rate,
    },
  };
}

/**
 * Query projects from database for a week
 * Returns projects active during the week (start before/during AND end during/after)
 */
function getProjectsForWeek(startDate, endDate) {
  const dbPath = path.join(projectRoot, '.data/today.db');
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);

  // Query projects that overlap with this week:
  // - Has due_date: project timeline overlaps the period
  // - No due_date + completed: start_date is within the period (was an event)
  // - No due_date + active: start_date is on or before period end (ongoing)
  const query = `
    SELECT id, title, status, priority, topic, start_date, due_date, progress, description, url
    FROM projects
    WHERE
      start_date IS NOT NULL
      AND start_date <= '${endStr}'
      AND (
        (due_date IS NOT NULL AND due_date <> 'TBD' AND due_date >= '${startStr}')
        OR (due_date IS NULL AND status IN ('completed', 'archived') AND start_date >= '${startStr}')
        OR (due_date IS NULL AND status NOT IN ('completed', 'archived'))
        OR (due_date = 'TBD' AND status NOT IN ('completed', 'archived'))
      )
    ORDER BY
      COALESCE(start_date, due_date) ASC,
      CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 6 END
  `;

  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${query}"`, { encoding: 'utf8' });
    return JSON.parse(result || '[]');
  } catch {
    return [];
  }
}

/**
 * Format projects for display in weekly plan
 */
function formatProjectsForWeek(projects, startDate, endDate) {
  if (projects.length === 0) return null;

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);

  // Add date badges to each project
  const enriched = projects.map(proj => ({
    ...proj,
    startsThisMonth: proj.start_date && proj.start_date >= startStr && proj.start_date <= endStr,
    endsThisMonth: proj.due_date && proj.due_date >= startStr && proj.due_date <= endStr,
  }));

  return formatProjectList(enriched);
}

/**
 * Update weekly plan file with projects from database
 * Uses markers: <!-- PROJECTS:START --> ... <!-- PROJECTS:END -->
 */
function updateWeeklyPlanWithProjects(weeklyPlanPath, startDate, endDate) {
  if (!fs.existsSync(weeklyPlanPath)) {
    return { updated: false, reason: 'file not found' };
  }

  const projects = getProjectsForWeek(startDate, endDate);

  if (projects.length === 0) {
    return { updated: false, reason: 'no projects', count: 0 };
  }

  let content = fs.readFileSync(weeklyPlanPath, 'utf-8');

  const formattedProjects = formatProjectsForWeek(projects, startDate, endDate);
  const startMarker = '<!-- PROJECTS:START -->';
  const endMarker = '<!-- PROJECTS:END -->';
  const newSection = `${startMarker}\n### Projects This Week\n\n${formattedProjects}\n${endMarker}`;

  // Check if markers already exist
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1) {
    // Replace existing section
    const before = content.substring(0, startIndex);
    const after = content.substring(endIndex + endMarker.length);
    content = before + newSection + after;
  } else {
    // Add new section after "Theme and Priorities" / before "Notes"
    const notesMatch = content.match(/### Notes\n/);
    const diaryNotesMatch = content.match(/<!-- DIARY_NOTES:START -->/);
    const projectsProgressMatch = content.match(/### Projects Progress/);

    if (notesMatch && notesMatch.index !== undefined) {
      content = content.substring(0, notesMatch.index) + newSection + '\n\n' + content.substring(notesMatch.index);
    } else if (diaryNotesMatch && diaryNotesMatch.index !== undefined) {
      content = content.substring(0, diaryNotesMatch.index) + newSection + '\n\n' + content.substring(diaryNotesMatch.index);
    } else if (projectsProgressMatch && projectsProgressMatch.index !== undefined) {
      content = content.substring(0, projectsProgressMatch.index) + newSection + '\n\n' + content.substring(projectsProgressMatch.index);
    } else {
      // Add before footer
      const footerMatch = content.match(/\n\*Week \d+ of \d+/);
      if (footerMatch && footerMatch.index !== undefined) {
        content = content.substring(0, footerMatch.index) + '\n' + newSection + '\n' + content.substring(footerMatch.index);
      } else {
        content += '\n\n' + newSection;
      }
    }
  }

  fs.writeFileSync(weeklyPlanPath, content, 'utf-8');

  return {
    updated: true,
    count: projects.length,
  };
}

/**
 * Query projects from database for a month
 * Returns projects active during the month (start before/during AND end during/after)
 */
function getProjectsForMonth(startDate, endDate) {
  const dbPath = path.join(projectRoot, '.data/today.db');
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);

  // Query projects that overlap with this month:
  // - Has due_date: project timeline overlaps the period
  // - No due_date + completed: start_date is within the period (was an event)
  // - No due_date + active: start_date is on or before period end (ongoing)
  const query = `
    SELECT id, title, status, priority, topic, start_date, due_date, progress, description, url
    FROM projects
    WHERE
      start_date IS NOT NULL
      AND start_date <= '${endStr}'
      AND (
        (due_date IS NOT NULL AND due_date <> 'TBD' AND due_date >= '${startStr}')
        OR (due_date IS NULL AND status IN ('completed', 'archived') AND start_date >= '${startStr}')
        OR (due_date IS NULL AND status NOT IN ('completed', 'archived'))
        OR (due_date = 'TBD' AND status NOT IN ('completed', 'archived'))
      )
    ORDER BY
      COALESCE(start_date, due_date) ASC,
      CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 6 END
  `;

  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${query}"`, { encoding: 'utf8' });
    return JSON.parse(result || '[]');
  } catch {
    return [];
  }
}

/**
 * Format projects for display in monthly plan
 */
function formatProjectsForMonth(projects, startDate, endDate) {
  if (projects.length === 0) return null;

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);

  const enriched = projects.map(proj => ({
    ...proj,
    startsThisMonth: proj.start_date && proj.start_date >= startStr && proj.start_date <= endStr,
    endsThisMonth: proj.due_date && proj.due_date >= startStr && proj.due_date <= endStr,
  }));

  return formatProjectList(enriched);
}

/**
 * Update monthly plan file with projects from database
 * Uses markers: <!-- PROJECTS:START --> ... <!-- PROJECTS:END -->
 */
function updateMonthlyPlanWithProjects(monthlyPlanPath, startDate, endDate) {
  if (!fs.existsSync(monthlyPlanPath)) {
    return { updated: false, reason: 'file not found' };
  }

  const projects = getProjectsForMonth(startDate, endDate);

  if (projects.length === 0) {
    return { updated: false, reason: 'no projects', count: 0 };
  }

  let content = fs.readFileSync(monthlyPlanPath, 'utf-8');

  const formattedProjects = formatProjectsForMonth(projects, startDate, endDate);
  const startMarker = '<!-- PROJECTS:START -->';
  const endMarker = '<!-- PROJECTS:END -->';
  const newSection = `${startMarker}\n### Projects\n\n${formattedProjects}\n${endMarker}`;

  // Check if markers already exist
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1) {
    // Replace existing section
    const before = content.substring(0, startIndex);
    const after = content.substring(endIndex + endMarker.length);
    content = before + newSection + after;
  } else {
    // Add new section before Time Tracking or Review section
    const timeTrackingMatch = content.match(/### ⏱️ Time Tracking/);
    const reviewMatch = content.match(/## 🔍 Review/);

    if (timeTrackingMatch && timeTrackingMatch.index !== undefined) {
      content = content.substring(0, timeTrackingMatch.index) + newSection + '\n\n' + content.substring(timeTrackingMatch.index);
    } else if (reviewMatch && reviewMatch.index !== undefined) {
      content = content.substring(0, reviewMatch.index) + newSection + '\n\n---\n\n' + content.substring(reviewMatch.index);
    } else {
      // Add before footer
      const footerMatch = content.match(/\n\*\w+ \d{4} \| Q\d\*/);
      if (footerMatch && footerMatch.index !== undefined) {
        content = content.substring(0, footerMatch.index) + '\n' + newSection + '\n' + content.substring(footerMatch.index);
      } else {
        content += '\n\n' + newSection;
      }
    }
  }

  fs.writeFileSync(monthlyPlanPath, content, 'utf-8');

  return {
    updated: true,
    count: projects.length,
  };
}

/**
 * Query projects from database for a quarter
 * Returns projects active during the quarter (start before/during AND end during/after)
 */
function getProjectsForQuarter(startDate, endDate) {
  const dbPath = path.join(projectRoot, '.data/today.db');
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);

  // Query projects that overlap with this quarter:
  // - Has due_date: project timeline overlaps the period
  // - No due_date + completed: start_date is within the period (was an event)
  // - No due_date + active: start_date is on or before period end (ongoing)
  const query = `
    SELECT id, title, status, priority, topic, start_date, due_date, progress, description, url
    FROM projects
    WHERE
      start_date IS NOT NULL
      AND start_date <= '${endStr}'
      AND (
        (due_date IS NOT NULL AND due_date <> 'TBD' AND due_date >= '${startStr}')
        OR (due_date IS NULL AND status IN ('completed', 'archived') AND start_date >= '${startStr}')
        OR (due_date IS NULL AND status NOT IN ('completed', 'archived'))
        OR (due_date = 'TBD' AND status NOT IN ('completed', 'archived'))
      )
    ORDER BY
      COALESCE(start_date, due_date) ASC,
      CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 6 END
  `;

  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${query}"`, { encoding: 'utf8' });
    return JSON.parse(result || '[]');
  } catch {
    return [];
  }
}

/**
 * Format projects for display in quarterly plan, grouped by month
 */
function formatProjectLine(proj) {
  const statusEmoji = {
    'active': '🟢',
    'planning': '📋',
    'on_hold': '⏸️',
    'completed': '✅',
    'archived': '📦',
  }[proj.status] || '•';

  let titleDisplay = proj.title;
  if (proj.url) {
    titleDisplay = `[${proj.title}](${proj.url})`;
  }

  const badges = [];
  if (proj.startsThisMonth && proj.start_date) {
    badges.push(`Starts ${proj.start_date}`);
  }
  if (proj.endsThisMonth && proj.due_date) {
    badges.push(`Due ${proj.due_date}`);
  }

  let line = `- ${statusEmoji} **${titleDisplay}**`;

  if (proj.status && proj.status !== 'active') {
    line += ` [${proj.status}]`;
  }

  if (proj.priority && proj.priority !== 'medium') {
    line += ` (${proj.priority})`;
  }

  if (badges.length > 0) {
    line += ` — ${badges.join(', ')}`;
  }

  if (proj.progress && proj.progress > 0) {
    line += ` (${proj.progress}%)`;
  }

  return line;
}

/**
 * Format a flat project list with active projects first, then paused/completed.
 * Used by week and month formatters (no sub-grouping).
 */
function formatProjectList(projects) {
  const inactiveStatuses = new Set(['completed', 'archived', 'on_hold']);
  const active = projects.filter(p => !inactiveStatuses.has(p.status));
  const inactive = projects.filter(p => inactiveStatuses.has(p.status));

  const lines = [];
  for (const proj of active) {
    lines.push(formatProjectLine(proj));
  }

  if (inactive.length > 0) {
    if (active.length > 0) lines.push('');
    lines.push('*Paused / Completed:*');
    for (const proj of inactive) {
      lines.push(formatProjectLine(proj));
    }
  }

  return lines.join('\n');
}

function formatProjectsForQuarter(projects, startDate, endDate) {
  if (projects.length === 0) return null;

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);

  // Group projects by the month they're active in
  // A project is active in a month if it starts, ends, or spans that month
  const monthGroups = {};
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];

  // Initialize month groups for the quarter
  let currentMonth = new Date(startDate);
  while (currentMonth <= endDate) {
    const key = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}`;
    monthGroups[key] = {
      name: monthNames[currentMonth.getMonth()],
      year: currentMonth.getFullYear(),
      projects: [],
    };
    currentMonth.setMonth(currentMonth.getMonth() + 1);
  }

  // Assign projects to months
  for (const proj of projects) {
    const projStart = proj.start_date ? new Date(proj.start_date + 'T00:00:00') : null;
    const projEnd = proj.due_date ? new Date(proj.due_date + 'T00:00:00') : null;

    // Determine which month(s) this project belongs to
    for (const [key, group] of Object.entries(monthGroups)) {
      const [year, month] = key.split('-').map(Number);
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 0); // Last day of month

      // Project belongs to this month if:
      // - It starts in this month, or
      // - It ends in this month
      const startsThisMonth = projStart && projStart >= monthStart && projStart <= monthEnd;
      const endsThisMonth = projEnd && projEnd >= monthStart && projEnd <= monthEnd;

      if (startsThisMonth || endsThisMonth) {
        group.projects.push({
          ...proj,
          startsThisMonth,
          endsThisMonth,
        });
      }
    }
  }

  // Format output
  const inactiveStatuses = new Set(['completed', 'archived', 'on_hold']);
  const lines = [];
  for (const [key, group] of Object.entries(monthGroups)) {
    if (group.projects.length === 0) continue;

    lines.push(`#### ${group.name}`);
    lines.push('');

    const activeProjects = group.projects.filter(p => !inactiveStatuses.has(p.status));
    const inactiveProjects = group.projects.filter(p => inactiveStatuses.has(p.status));

    for (const proj of activeProjects) {
      lines.push(formatProjectLine(proj));
    }

    if (inactiveProjects.length > 0) {
      if (activeProjects.length > 0) lines.push('');
      lines.push('*Paused / Completed:*');
      for (const proj of inactiveProjects) {
        lines.push(formatProjectLine(proj));
      }
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Update quarterly plan file with projects from database, grouped by month
 * Uses markers: <!-- PROJECTS:START --> ... <!-- PROJECTS:END -->
 */
function updateQuarterlyPlanWithProjects(quarterlyPlanPath, startDate, endDate) {
  if (!fs.existsSync(quarterlyPlanPath)) {
    return { updated: false, reason: 'file not found' };
  }

  const projects = getProjectsForQuarter(startDate, endDate);

  if (projects.length === 0) {
    return { updated: false, reason: 'no projects', count: 0 };
  }

  let content = fs.readFileSync(quarterlyPlanPath, 'utf-8');

  const formattedProjects = formatProjectsForQuarter(projects, startDate, endDate);
  if (!formattedProjects) {
    return { updated: false, reason: 'no projects in date range', count: 0 };
  }

  const startMarker = '<!-- PROJECTS:START -->';
  const endMarker = '<!-- PROJECTS:END -->';
  const newSection = `${startMarker}\n### Projects\n\n${formattedProjects}\n${endMarker}`;

  // Check if markers already exist
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1) {
    // Replace existing section
    const before = content.substring(0, startIndex);
    const after = content.substring(endIndex + endMarker.length);
    content = before + newSection + after;
  } else {
    // Add new section before Time Tracking or Review section
    const timeTrackingMatch = content.match(/### ⏱️ Time Tracking/);
    const reviewMatch = content.match(/## 🔍 Review/);

    if (timeTrackingMatch && timeTrackingMatch.index !== undefined) {
      content = content.substring(0, timeTrackingMatch.index) + newSection + '\n\n' + content.substring(timeTrackingMatch.index);
    } else if (reviewMatch && reviewMatch.index !== undefined) {
      content = content.substring(0, reviewMatch.index) + newSection + '\n\n---\n\n' + content.substring(reviewMatch.index);
    } else {
      // Add before footer
      const footerMatch = content.match(/\n\*Q\d \d{4}/);
      if (footerMatch && footerMatch.index !== undefined) {
        content = content.substring(0, footerMatch.index) + '\n' + newSection + '\n' + content.substring(footerMatch.index);
      } else {
        content += '\n\n' + newSection;
      }
    }
  }

  fs.writeFileSync(quarterlyPlanPath, content, 'utf-8');

  return {
    updated: true,
    count: projects.length,
  };
}

/**
 * Get quarter start and end dates from a quarterly plan file's frontmatter
 */
function getQuarterDatesFromPlan(quarterlyPlanPath) {
  if (!fs.existsSync(quarterlyPlanPath)) return null;

  const content = fs.readFileSync(quarterlyPlanPath, 'utf-8');
  const { frontmatter } = parseFrontmatter(content);

  if (!frontmatter.start_date) return null;

  const startDate = new Date(frontmatter.start_date + 'T00:00:00');
  let endDate;

  if (frontmatter.end_date) {
    endDate = new Date(frontmatter.end_date + 'T23:59:59');
  } else {
    // Default to end of quarter (3 months from start)
    endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 3, 0);
    endDate.setHours(23, 59, 59);
  }

  return { startDate, endDate };
}

/**
 * Query projects from database for a year
 * Returns projects active during the year (start before/during AND end during/after)
 */
function getProjectsForYear(startDate, endDate) {
  const dbPath = path.join(projectRoot, '.data/today.db');
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);

  // Query projects that overlap with this year:
  // - Has due_date: project timeline overlaps the period
  // - No due_date + completed: start_date is within the period (was an event)
  // - No due_date + active: start_date is on or before period end (ongoing)
  const query = `
    SELECT id, title, status, priority, topic, start_date, due_date, progress, description, url
    FROM projects
    WHERE
      start_date IS NOT NULL
      AND start_date <= '${endStr}'
      AND (
        (due_date IS NOT NULL AND due_date <> 'TBD' AND due_date >= '${startStr}')
        OR (due_date IS NULL AND status IN ('completed', 'archived') AND start_date >= '${startStr}')
        OR (due_date IS NULL AND status NOT IN ('completed', 'archived'))
        OR (due_date = 'TBD' AND status NOT IN ('completed', 'archived'))
      )
    ORDER BY
      COALESCE(start_date, due_date) ASC,
      CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 6 END
  `;

  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${query}"`, { encoding: 'utf8' });
    return JSON.parse(result || '[]');
  } catch {
    return [];
  }
}

/**
 * Format projects for display in yearly plan, grouped by quarter
 */
function formatProjectsForYear(projects, startDate, endDate) {
  if (projects.length === 0) return null;

  const year = startDate.getFullYear();

  // Group projects by quarter
  const quarterGroups = {
    'Q1': { name: 'Q1 (Jan-Mar)', projects: [] },
    'Q2': { name: 'Q2 (Apr-Jun)', projects: [] },
    'Q3': { name: 'Q3 (Jul-Sep)', projects: [] },
    'Q4': { name: 'Q4 (Oct-Dec)', projects: [] },
  };

  // Quarter date ranges
  const quarterRanges = {
    'Q1': { start: new Date(year, 0, 1), end: new Date(year, 2, 31) },
    'Q2': { start: new Date(year, 3, 1), end: new Date(year, 5, 30) },
    'Q3': { start: new Date(year, 6, 1), end: new Date(year, 8, 30) },
    'Q4': { start: new Date(year, 9, 1), end: new Date(year, 11, 31) },
  };

  // Assign projects to quarters
  for (const proj of projects) {
    const projStart = proj.start_date ? new Date(proj.start_date + 'T00:00:00') : null;
    const projEnd = proj.due_date ? new Date(proj.due_date + 'T00:00:00') : null;

    for (const [quarter, range] of Object.entries(quarterRanges)) {
      // Project belongs to this quarter if it starts or ends in it
      const startsThisQuarter = projStart && projStart >= range.start && projStart <= range.end;
      const endsThisQuarter = projEnd && projEnd >= range.start && projEnd <= range.end;

      if (startsThisQuarter || endsThisQuarter) {
        quarterGroups[quarter].projects.push({
          ...proj,
          startsThisQuarter,
          endsThisQuarter,
        });
      }
    }
  }

  // Format output
  const inactiveStatuses = new Set(['completed', 'archived', 'on_hold']);
  const lines = [];
  for (const [quarter, group] of Object.entries(quarterGroups)) {
    if (group.projects.length === 0) continue;

    lines.push(`#### ${group.name}`);
    lines.push('');

    // Map quarter date fields to the generic names formatProjectLine expects
    const mapped = group.projects.map(p => ({
      ...p,
      startsThisMonth: p.startsThisQuarter,
      endsThisMonth: p.endsThisQuarter,
    }));

    const activeProjects = mapped.filter(p => !inactiveStatuses.has(p.status));
    const inactiveProjects = mapped.filter(p => inactiveStatuses.has(p.status));

    for (const proj of activeProjects) {
      lines.push(formatProjectLine(proj));
    }

    if (inactiveProjects.length > 0) {
      if (activeProjects.length > 0) lines.push('');
      lines.push('*Paused / Completed:*');
      for (const proj of inactiveProjects) {
        lines.push(formatProjectLine(proj));
      }
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Update yearly plan file with projects from database, grouped by quarter
 * Uses markers: <!-- PROJECTS:START --> ... <!-- PROJECTS:END -->
 */
function updateYearlyPlanWithProjects(yearlyPlanPath, startDate, endDate) {
  if (!fs.existsSync(yearlyPlanPath)) {
    return { updated: false, reason: 'file not found' };
  }

  const projects = getProjectsForYear(startDate, endDate);

  if (projects.length === 0) {
    return { updated: false, reason: 'no projects', count: 0 };
  }

  let content = fs.readFileSync(yearlyPlanPath, 'utf-8');

  const formattedProjects = formatProjectsForYear(projects, startDate, endDate);
  if (!formattedProjects) {
    return { updated: false, reason: 'no projects in date range', count: 0 };
  }

  const startMarker = '<!-- PROJECTS:START -->';
  const endMarker = '<!-- PROJECTS:END -->';
  const newSection = `${startMarker}\n### Projects\n\n${formattedProjects}\n${endMarker}`;

  // Check if markers already exist
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1) {
    // Replace existing section
    const before = content.substring(0, startIndex);
    const after = content.substring(endIndex + endMarker.length);
    content = before + newSection + after;
  } else {
    // Add new section after "Annual Goals" section (after its dataview block)
    // Look for the pattern: ### Annual Goals followed by dataview block, then ---
    const annualGoalsMatch = content.match(/### Annual Goals[\s\S]*?```\n\n---/);
    const reviewMatch = content.match(/## 🔍 Review/);

    if (annualGoalsMatch && annualGoalsMatch.index !== undefined) {
      // Insert before the --- that follows Annual Goals
      const insertPoint = annualGoalsMatch.index + annualGoalsMatch[0].length - 3; // before ---
      content = content.substring(0, insertPoint) + newSection + '\n\n' + content.substring(insertPoint);
    } else if (reviewMatch && reviewMatch.index !== undefined) {
      content = content.substring(0, reviewMatch.index) + newSection + '\n\n---\n\n' + content.substring(reviewMatch.index);
    } else {
      // Add before footer
      const footerMatch = content.match(/\n\*\d{4} Annual Plan\*/);
      if (footerMatch && footerMatch.index !== undefined) {
        content = content.substring(0, footerMatch.index) + '\n' + newSection + '\n' + content.substring(footerMatch.index);
      } else {
        content += '\n\n' + newSection;
      }
    }
  }

  fs.writeFileSync(yearlyPlanPath, content, 'utf-8');

  return {
    updated: true,
    count: projects.length,
  };
}

/**
 * Get year start and end dates from a yearly plan file's frontmatter
 */
function getYearDatesFromPlan(yearlyPlanPath) {
  if (!fs.existsSync(yearlyPlanPath)) return null;

  const content = fs.readFileSync(yearlyPlanPath, 'utf-8');
  const { frontmatter } = parseFrontmatter(content);

  if (!frontmatter.start_date) return null;

  const startDate = new Date(frontmatter.start_date + 'T00:00:00');
  let endDate;

  if (frontmatter.end_date) {
    endDate = new Date(frontmatter.end_date + 'T23:59:59');
  } else {
    // Default to end of year
    endDate = new Date(startDate.getFullYear(), 11, 31);
    endDate.setHours(23, 59, 59);
  }

  return { startDate, endDate };
}

/**
 * Update all FUTURE plan files (weekly and above) with projects from database
 * This ensures projects scheduled for future quarters/months appear in those plan files
 */
function updateFuturePlanFilesWithProjects(today) {
  const results = { quarterly: 0, monthly: 0, weekly: 0 };

  // Get all plan files in the plans directory
  if (!fs.existsSync(plansDir)) {
    return results;
  }

  const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
  const todayStr = formatDateStr(today);

  for (const file of files) {
    const filePath = path.join(plansDir, file);

    // Skip if not a plan file (must have _00.md suffix for non-daily plans)
    if (!file.includes('_00.md')) continue;

    // Determine plan type from filename pattern
    // Quarter: YYYY_Q#_00.md
    // Month: YYYY_Q#_MM_00.md
    // Week: YYYY_Q#_MM_W##_00.md
    const quarterMatch = file.match(/^(\d{4})_Q(\d)_00\.md$/);
    const monthMatch = file.match(/^(\d{4})_Q(\d)_(\d{2})_00\.md$/);
    const weekMatch = file.match(/^(\d{4})_Q(\d)_(\d{2})_W(\d{2})_00\.md$/);

    if (quarterMatch) {
      // Quarterly plan
      const quarterDates = getQuarterDatesFromPlan(filePath);
      if (quarterDates && formatDateStr(quarterDates.startDate) > todayStr) {
        const result = updateQuarterlyPlanWithProjects(
          filePath,
          quarterDates.startDate,
          quarterDates.endDate
        );
        if (result.updated) results.quarterly++;
      }
    } else if (monthMatch) {
      // Monthly plan
      const monthDates = getMonthDatesFromPlan(filePath);
      if (monthDates && formatDateStr(monthDates.startDate) > todayStr) {
        const result = updateMonthlyPlanWithProjects(
          filePath,
          monthDates.startDate,
          monthDates.endDate
        );
        if (result.updated) results.monthly++;
      }
    } else if (weekMatch) {
      // Weekly plan
      const weekDates = getWeekDatesFromPlan(filePath);
      if (weekDates && formatDateStr(weekDates.startDate) > todayStr) {
        const result = updateWeeklyPlanWithProjects(
          filePath,
          weekDates.startDate,
          weekDates.endDate
        );
        if (result.updated) results.weekly++;
      }
    }
  }

  return results;
}

/**
 * Get data relevant to a time period for generating theme/goal suggestions
 * Queries projects, tasks, and calendar events from the database
 */
function getDataForPeriod(startDate, endDate) {
  const dbPath = path.join(projectRoot, '.data/today.db');
  if (!fs.existsSync(dbPath)) {
    return {};
  }

  const startStr = formatDateStr(startDate);
  const endStr = formatDateStr(endDate);
  const data = {};

  // Date field patterns to look for in schemas
  const dateFieldPatterns = ['date', 'start_date', 'due_date', 'start_time', 'end_time', 'opened_at', 'completed_at'];

  // Iterate through all schemas dynamically
  for (const [pluginType, schema] of Object.entries(schemas)) {
    if (!schema.table) continue; // Skip types without tables (context, utility)

    const tableName = schema.table;
    const fields = schema.fields;

    // Find date fields in this schema
    const dateFields = [];
    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      if (dateFieldPatterns.includes(fieldName) ||
          (fieldDef.sqlType && (fieldDef.sqlType.includes('DATE') || fieldDef.sqlType.includes('DATETIME')))) {
        dateFields.push(fieldName);
      }
    }

    if (dateFields.length === 0) continue; // No date fields to filter on

    // Build WHERE clause for date range
    const dateConditions = dateFields.map(f => {
      // Use DATE() function to normalize datetime fields
      return `(${f} IS NOT NULL AND DATE(${f}) >= '${startStr}' AND DATE(${f}) <= '${endStr}')`;
    });

    // Special handling for projects (range-based: start_date to due_date)
    let whereClause;
    if (tableName === 'projects' && fields.start_date && fields.due_date) {
      whereClause = `
        (status = 'active' OR status = 'completed') AND (
          (start_date IS NOT NULL AND start_date <= '${endStr}' AND (due_date IS NULL OR due_date >= '${startStr}'))
          OR (due_date IS NOT NULL AND due_date >= '${startStr}' AND due_date <= '${endStr}')
        )`;
    } else {
      whereClause = dateConditions.join(' OR ');
    }

    // Get display fields (exclude large text fields and metadata for summary)
    const displayFields = [];
    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      // Skip very large fields
      if (['html_content', 'text_content', 'metadata', 'body', 'attachments'].includes(fieldName)) continue;
      // Include the field
      displayFields.push(fieldName);
    }

    // Limit fields to keep query reasonable
    const selectFields = displayFields.slice(0, 10).join(', ');

    // Build and execute query
    const query = `SELECT ${selectFields} FROM ${tableName} WHERE ${whereClause} LIMIT 30`;

    try {
      const result = execSync(`sqlite3 -json "${dbPath}" "${query.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const rows = JSON.parse(result || '[]');
      if (rows.length > 0) {
        data[tableName] = rows;
      }
    } catch (e) {
      // Table might not exist or query failed - that's ok
    }
  }

  return data;
}

/**
 * Check if a plan file has empty theme/goals
 * Returns the field names and whether they're empty
 */
function getPlanThemeGoalsStatus(planPath, planType) {
  if (!fs.existsSync(planPath)) return null;

  const content = fs.readFileSync(planPath, 'utf-8');
  const { frontmatter } = parseFrontmatter(content);

  // Field names vary by plan type
  const fieldMap = {
    year: { theme: 'year_theme', goals: 'year_goals' },
    quarter: { theme: 'quarter_theme', goals: 'quarter_goals' },
    month: { theme: 'month_theme', goals: 'month_goals' },
    week: { theme: 'week_theme', goals: 'week_priorities' },
  };

  const fields = fieldMap[planType];
  if (!fields) return null;

  const theme = frontmatter[fields.theme];
  const goals = frontmatter[fields.goals];

  // Check if theme is empty
  const themeEmpty = !theme || theme.trim() === '';

  // Check if goals are empty (array with empty/placeholder items)
  const goalsEmpty = !goals || !Array.isArray(goals) ||
    goals.length === 0 ||
    goals.every(g => !g || g.trim() === '' || g.trim() === '-');

  return {
    themeField: fields.theme,
    goalsField: fields.goals,
    themeEmpty,
    goalsEmpty,
    currentTheme: theme,
    currentGoals: goals,
  };
}

/**
 * Generate suggested theme and goals for a plan using AI
 */
async function suggestThemeAndGoals(planPath, planType, startDate, endDate) {
  // Check if AI is available
  if (!(await isAIAvailable())) {
    return null;
  }

  // Get relevant data for this period from all database tables
  const data = getDataForPeriod(startDate, endDate);

  // Format period description
  const periodDesc = {
    year: `the year ${startDate.getFullYear()}`,
    quarter: `Q${getQuarter(startDate.getMonth() + 1)} ${startDate.getFullYear()} (${startDate.toLocaleDateString('en-US', { month: 'long' })} - ${endDate.toLocaleDateString('en-US', { month: 'long' })})`,
    month: startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    week: `the week of ${startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
  }[planType];

  // Build context dynamically from all available data
  let context = '';

  // Map table names to human-readable names and format functions
  const tableFormatters = {
    projects: {
      name: 'PROJECTS',
      format: (rows) => rows.map(p => {
        let line = `- ${p.title}`;
        if (p.priority) line += ` (${p.priority})`;
        if (p.due_date) line += ` due ${p.due_date}`;
        if (p.progress) line += ` [${p.progress}%]`;
        return line;
      }).join('\n')
    },
    tasks: {
      name: 'TASKS',
      format: (rows) => rows.slice(0, 15).map(t => {
        let line = `- ${t.title || t.content}`;
        if (t.priority) line += ` (${t.priority})`;
        if (t.due_date) line += ` due ${t.due_date}`;
        return line;
      }).join('\n')
    },
    events: {
      name: 'CALENDAR EVENTS',
      format: (rows) => rows.slice(0, 15).map(e => {
        const date = e.start_date ? new Date(e.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        let line = `- ${date ? date + ': ' : ''}${e.title}`;
        if (e.location) line += ` @ ${e.location}`;
        return line;
      }).join('\n')
    },
    diary: {
      name: 'DIARY ENTRIES',
      format: (rows) => rows.slice(0, 5).map(d => {
        const date = d.date ? new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const preview = (d.text || '').slice(0, 150).replace(/\n/g, ' ');
        return `- ${date}: ${preview}...`;
      }).join('\n')
    },
    time_logs: {
      name: 'TIME TRACKED',
      format: (rows) => {
        // Group by description and sum time
        const byDesc = {};
        for (const t of rows) {
          const desc = t.description || 'Untracked';
          byDesc[desc] = (byDesc[desc] || 0) + (t.duration_minutes || 0);
        }
        return Object.entries(byDesc)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([desc, mins]) => `- ${desc}: ${Math.round(mins / 60 * 10) / 10}h`)
          .join('\n');
      }
    },
    habits: {
      name: 'HABITS',
      format: (rows) => {
        // Group by habit title and count completions
        const byHabit = {};
        for (const h of rows) {
          if (!byHabit[h.title]) byHabit[h.title] = { completed: 0, total: 0 };
          byHabit[h.title].total++;
          if (h.status === 'completed') byHabit[h.title].completed++;
        }
        return Object.entries(byHabit)
          .map(([title, stats]) => `- ${title}: ${stats.completed}/${stats.total} days`)
          .join('\n');
      }
    },
    issues: {
      name: 'ISSUES/TICKETS',
      format: (rows) => rows.slice(0, 10).map(i => {
        return `- [${i.state}] ${i.title}`;
      }).join('\n')
    },
    health_metrics: {
      name: 'HEALTH METRICS',
      format: (rows) => {
        // Group by metric and show average
        const byMetric = {};
        for (const h of rows) {
          if (!byMetric[h.metric_name]) byMetric[h.metric_name] = { sum: 0, count: 0, units: h.units };
          byMetric[h.metric_name].sum += h.value || 0;
          byMetric[h.metric_name].count++;
        }
        return Object.entries(byMetric)
          .slice(0, 8)
          .map(([name, stats]) => {
            const avg = Math.round(stats.sum / stats.count);
            return `- ${name}: avg ${avg} ${stats.units || ''}`;
          })
          .join('\n');
      }
    },
    contacts: {
      name: 'BIRTHDAYS',
      format: (rows) => rows.filter(c => c.birthday).slice(0, 5).map(c => {
        return `- ${c.full_name}'s birthday`;
      }).join('\n')
    },
    financial_transactions: {
      name: 'SPENDING SUMMARY',
      format: (rows) => {
        // Group by category
        const byCategory = {};
        for (const t of rows) {
          const cat = t.category || 'Uncategorized';
          byCategory[cat] = (byCategory[cat] || 0) + (t.amount || 0);
        }
        return Object.entries(byCategory)
          .sort((a, b) => a[1] - b[1]) // Most negative (spent) first
          .slice(0, 8)
          .map(([cat, amt]) => `- ${cat}: $${Math.abs(amt).toFixed(0)}`)
          .join('\n');
      }
    }
  };

  // Format each table's data
  for (const [tableName, rows] of Object.entries(data)) {
    if (!rows || rows.length === 0) continue;

    const formatter = tableFormatters[tableName];
    if (formatter) {
      const formatted = formatter.format(rows);
      if (formatted && formatted.trim()) {
        context += `\n\n${formatter.name}:\n${formatted}`;
      }
    } else {
      // Generic fallback for unknown tables
      context += `\n\n${tableName.toUpperCase().replace(/_/g, ' ')}:\n`;
      context += rows.slice(0, 10).map(r => {
        // Try common field names
        const title = r.title || r.name || r.content || r.description || r.subject || JSON.stringify(r).slice(0, 100);
        return `- ${title}`;
      }).join('\n');
    }
  }

  if (!context.trim()) {
    return null; // No data to base suggestions on
  }

  const goalsFieldName = planType === 'week' ? 'priorities' : 'goals';
  const numGoals = planType === 'week' ? 3 : (planType === 'month' ? 3 : (planType === 'quarter' ? 3 : 5));

  const prompt = `Based on the following data for ${periodDesc}, suggest:
1. A concise theme (3-6 words) that captures the main focus or character of this period
2. ${numGoals} specific, actionable ${goalsFieldName}

Consider ALL the data types below - projects, events, diary entries, habits, time tracking, health, etc.
The theme should reflect what makes this specific period unique, not just generic goals.

${context}

Respond in this exact format:
THEME: [your theme here]
${goalsFieldName.toUpperCase()}:
- [${goalsFieldName.slice(0, -1)} 1]
- [${goalsFieldName.slice(0, -1)} 2]
- [${goalsFieldName.slice(0, -1)} 3]${numGoals > 3 ? '\n- [' + goalsFieldName.slice(0, -1) + ' 4]' : ''}${numGoals > 4 ? '\n- [' + goalsFieldName.slice(0, -1) + ' 5]' : ''}

Make the theme distinctive to THIS period. Make ${goalsFieldName} specific and achievable.`;

  try {
    const response = await createCompletion({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 400,
      temperature: 0.7,
    });

    if (!response) return null;

    // Parse response (createCompletion returns a string directly)
    const text = response.trim();
    const themeMatch = text.match(/THEME:\s*(.+)/i);
    const goalsMatch = text.match(new RegExp(`${goalsFieldName.toUpperCase()}:\\s*\\n([\\s\\S]+)`, 'i'));

    if (!themeMatch) return null;

    const theme = themeMatch[1].trim();
    const goals = [];

    if (goalsMatch) {
      const goalsText = goalsMatch[1];
      const goalLines = goalsText.split('\n').filter(line => line.trim().startsWith('-'));
      for (const line of goalLines) {
        const goal = line.replace(/^-\s*/, '').trim();
        if (goal) goals.push(goal);
      }
    }

    return { theme, goals };
  } catch (e) {
    return null;
  }
}

/**
 * Update a plan file with suggested theme and goals
 */
function updatePlanWithThemeGoals(planPath, planType, theme, goals) {
  if (!fs.existsSync(planPath)) return false;

  let content = fs.readFileSync(planPath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  const fieldMap = {
    year: { theme: 'year_theme', goals: 'year_goals' },
    quarter: { theme: 'quarter_theme', goals: 'quarter_goals' },
    month: { theme: 'month_theme', goals: 'month_goals' },
    week: { theme: 'week_theme', goals: 'week_priorities' },
  };

  const fields = fieldMap[planType];
  if (!fields) return false;

  // Update frontmatter
  frontmatter[fields.theme] = theme;
  frontmatter[fields.goals] = goals;

  // Rebuild the file
  const yamlContent = Object.entries(frontmatter)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return `${key}:\n  -`;
        }
        return `${key}:\n${value.map(v => `  - ${v || ''}`).join('\n')}`;
      }
      if (value === null || value === undefined) {
        return `${key}:`;
      }
      return `${key}: ${value}`;
    })
    .join('\n');

  content = `---\n${yamlContent}\n---\n${body}`;
  fs.writeFileSync(planPath, content, 'utf-8');

  return true;
}

/**
 * Find and update plan files that are missing themes/goals
 * Only processes current and future plans (weekly and above)
 */
async function suggestMissingThemesAndGoals(today) {
  const results = { suggested: [], skipped: [] };

  if (!fs.existsSync(plansDir)) {
    return results;
  }

  // Check if AI is available
  if (!(await isAIAvailable())) {
    return results;
  }

  const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
  const todayStr = formatDateStr(today);

  for (const file of files) {
    const filePath = path.join(plansDir, file);

    // Skip daily plans (no _00.md suffix)
    if (!file.includes('_00.md')) continue;

    // Determine plan type and dates
    let planType = null;
    let dates = null;

    const yearMatch = file.match(/^(\d{4})_00\.md$/);
    const quarterMatch = file.match(/^(\d{4})_Q(\d)_00\.md$/);
    const monthMatch = file.match(/^(\d{4})_Q(\d)_(\d{2})_00\.md$/);
    const weekMatch = file.match(/^(\d{4})_Q(\d)_(\d{2})_W(\d{2})_00\.md$/);

    if (yearMatch) {
      planType = 'year';
      dates = getYearDatesFromPlan(filePath);
    } else if (quarterMatch) {
      planType = 'quarter';
      dates = getQuarterDatesFromPlan(filePath);
    } else if (monthMatch) {
      planType = 'month';
      dates = getMonthDatesFromPlan(filePath);
    } else if (weekMatch) {
      planType = 'week';
      dates = getWeekDatesFromPlan(filePath);
    }

    if (!planType || !dates) continue;

    // Check if theme/goals are empty
    const status = getPlanThemeGoalsStatus(filePath, planType);
    if (!status) continue;

    // Skip if both are already filled
    if (!status.themeEmpty && !status.goalsEmpty) continue;

    // Generate suggestions
    const suggestion = await suggestThemeAndGoals(filePath, planType, dates.startDate, dates.endDate);

    if (suggestion && suggestion.theme && suggestion.goals && suggestion.goals.length > 0) {
      // Only update if we have good suggestions
      const updated = updatePlanWithThemeGoals(filePath, planType, suggestion.theme, suggestion.goals);
      if (updated) {
        results.suggested.push({
          file,
          type: planType,
          theme: suggestion.theme,
          goals: suggestion.goals,
        });
      }
    } else {
      results.skipped.push({ file, type: planType, reason: 'no data or AI unavailable' });
    }
  }

  return results;
}

/**
 * Check if a plan file has an empty summary
 */
function getPlanSummaryStatus(planPath, planType) {
  if (!fs.existsSync(planPath)) return null;

  const content = fs.readFileSync(planPath, 'utf-8');
  const { frontmatter } = parseFrontmatter(content);

  // Field names vary by plan type
  const fieldMap = {
    year: 'year_summary',
    quarter: 'quarter_summary',
    month: 'month_summary',
    week: 'week_summary',
  };

  const summaryField = fieldMap[planType];
  if (!summaryField) return null;

  const summary = frontmatter[summaryField];
  const isEmpty = !summary || summary.trim() === '' || summary.trim() === 'No daily summaries available for this week';

  return {
    summaryField,
    isEmpty,
    currentSummary: summary,
  };
}

/**
 * Generate a summary for a past plan period using AI
 */
async function generatePlanSummary(planPath, planType, startDate, endDate) {
  // Check if AI is available
  if (!(await isAIAvailable())) {
    return null;
  }

  // Get relevant data for this period from all database tables
  const data = getDataForPeriod(startDate, endDate);

  // Format period description
  const periodDesc = {
    year: `the year ${startDate.getFullYear()}`,
    quarter: `Q${getQuarter(startDate.getMonth() + 1)} ${startDate.getFullYear()} (${startDate.toLocaleDateString('en-US', { month: 'long' })} - ${endDate.toLocaleDateString('en-US', { month: 'long' })})`,
    month: startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    week: `the week of ${startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
  }[planType];

  // Build context dynamically from all available data (same as theme generation)
  let context = '';

  const tableFormatters = {
    projects: {
      name: 'PROJECTS',
      format: (rows) => rows.map(p => {
        let line = `- ${p.title}`;
        if (p.status === 'completed') line += ' [COMPLETED]';
        if (p.progress) line += ` [${p.progress}%]`;
        return line;
      }).join('\n')
    },
    tasks: {
      name: 'TASKS',
      format: (rows) => {
        const completed = rows.filter(t => t.status === 'completed').length;
        const total = rows.length;
        let result = `Completed ${completed}/${total} tasks`;
        const highPriority = rows.filter(t => t.priority === 'high' || t.priority === 'highest');
        if (highPriority.length > 0) {
          result += '\nKey tasks: ' + highPriority.slice(0, 5).map(t => t.title || t.content).join(', ');
        }
        return result;
      }
    },
    events: {
      name: 'CALENDAR EVENTS',
      format: (rows) => rows.slice(0, 10).map(e => {
        const date = e.start_date ? new Date(e.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        return `- ${date ? date + ': ' : ''}${e.title}`;
      }).join('\n')
    },
    diary: {
      name: 'DIARY ENTRIES',
      format: (rows) => rows.slice(0, 8).map(d => {
        const date = d.date ? new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const preview = (d.text || '').slice(0, 200).replace(/\n/g, ' ');
        return `- ${date}: ${preview}...`;
      }).join('\n')
    },
    time_logs: {
      name: 'TIME TRACKED',
      format: (rows) => {
        const byDesc = {};
        for (const t of rows) {
          const desc = t.description || 'Untracked';
          byDesc[desc] = (byDesc[desc] || 0) + (t.duration_minutes || 0);
        }
        const total = Object.values(byDesc).reduce((a, b) => a + b, 0);
        return `Total: ${Math.round(total / 60)}h tracked\nTop activities:\n` +
          Object.entries(byDesc)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([desc, mins]) => `- ${desc}: ${Math.round(mins / 60 * 10) / 10}h`)
            .join('\n');
      }
    },
    habits: {
      name: 'HABITS',
      format: (rows) => {
        const byHabit = {};
        for (const h of rows) {
          if (!byHabit[h.title]) byHabit[h.title] = { completed: 0, total: 0 };
          byHabit[h.title].total++;
          if (h.status === 'completed') byHabit[h.title].completed++;
        }
        return Object.entries(byHabit)
          .map(([title, stats]) => {
            const pct = Math.round(stats.completed / stats.total * 100);
            return `- ${title}: ${pct}% (${stats.completed}/${stats.total})`;
          })
          .join('\n');
      }
    },
    health_metrics: {
      name: 'HEALTH',
      format: (rows) => {
        const byMetric = {};
        for (const h of rows) {
          if (!byMetric[h.metric_name]) byMetric[h.metric_name] = { sum: 0, count: 0, units: h.units };
          byMetric[h.metric_name].sum += h.value || 0;
          byMetric[h.metric_name].count++;
        }
        return Object.entries(byMetric)
          .slice(0, 6)
          .map(([name, stats]) => {
            const avg = Math.round(stats.sum / stats.count);
            return `- ${name}: avg ${avg} ${stats.units || ''}`;
          })
          .join('\n');
      }
    }
  };

  // Format each table's data
  for (const [tableName, rows] of Object.entries(data)) {
    if (!rows || rows.length === 0) continue;

    const formatter = tableFormatters[tableName];
    if (formatter) {
      const formatted = formatter.format(rows);
      if (formatted && formatted.trim()) {
        context += `\n\n${formatter.name}:\n${formatted}`;
      }
    }
  }

  if (!context.trim()) {
    return null;
  }

  const sentenceCount = planType === 'week' ? '2-3' : (planType === 'month' ? '3-4' : '4-5');

  const prompt = `Write a ${sentenceCount} sentence narrative summary of what happened during ${periodDesc}.

This is a RETROSPECTIVE summary - describe what was accomplished, experienced, and notable about this period.
Focus on:
- Major accomplishments and completed work
- Key events and experiences
- Overall character/mood of the period
- Any significant challenges or breakthroughs

DATA FOR THIS PERIOD:
${context}

Write ONLY the summary, ${sentenceCount} sentences, nothing else. Be specific and personal, not generic.`;

  try {
    const response = await createCompletion({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 400,
      temperature: 0.7,
    });
    return response ? response.trim() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Update a plan file with a generated summary
 */
function updatePlanWithSummary(planPath, planType, summary) {
  if (!fs.existsSync(planPath)) return false;

  let content = fs.readFileSync(planPath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  const fieldMap = {
    year: 'year_summary',
    quarter: 'quarter_summary',
    month: 'month_summary',
    week: 'week_summary',
  };

  const summaryField = fieldMap[planType];
  if (!summaryField) return false;

  // Escape quotes in summary for YAML
  const escapedSummary = summary.replace(/"/g, '\\"').replace(/\n/g, ' ');
  frontmatter[summaryField] = escapedSummary;

  // Rebuild the file
  const yamlContent = Object.entries(frontmatter)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return `${key}:\n  -`;
        }
        return `${key}:\n${value.map(v => `  - ${v || ''}`).join('\n')}`;
      }
      if (value === null || value === undefined) {
        return `${key}:`;
      }
      return `${key}: ${value}`;
    })
    .join('\n');

  content = `---\n${yamlContent}\n---\n${body}`;
  fs.writeFileSync(planPath, content, 'utf-8');

  return true;
}

/**
 * Find and update PAST plan files that are missing summaries
 * Only processes past plans (weekly and above)
 */
async function suggestMissingSummaries(today) {
  const results = { suggested: [], skipped: [] };

  if (!fs.existsSync(plansDir)) {
    return results;
  }

  // Check if AI is available
  if (!(await isAIAvailable())) {
    return results;
  }

  const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
  const todayStr = formatDateStr(today);

  for (const file of files) {
    const filePath = path.join(plansDir, file);

    // Skip daily plans (no _00.md suffix) - they have their own summary generation
    if (!file.includes('_00.md')) continue;

    // Determine plan type and dates
    let planType = null;
    let dates = null;

    const yearMatch = file.match(/^(\d{4})_00\.md$/);
    const quarterMatch = file.match(/^(\d{4})_Q(\d)_00\.md$/);
    const monthMatch = file.match(/^(\d{4})_Q(\d)_(\d{2})_00\.md$/);
    const weekMatch = file.match(/^(\d{4})_Q(\d)_(\d{2})_W(\d{2})_00\.md$/);

    if (yearMatch) {
      planType = 'year';
      dates = getYearDatesFromPlan(filePath);
    } else if (quarterMatch) {
      planType = 'quarter';
      dates = getQuarterDatesFromPlan(filePath);
    } else if (monthMatch) {
      planType = 'month';
      dates = getMonthDatesFromPlan(filePath);
    } else if (weekMatch) {
      planType = 'week';
      dates = getWeekDatesFromPlan(filePath);
    }

    if (!planType || !dates) continue;

    // Only process PAST plans (end date before today)
    if (formatDateStr(dates.endDate) >= todayStr) continue;

    // Check if summary is empty
    const status = getPlanSummaryStatus(filePath, planType);
    if (!status || !status.isEmpty) continue;

    // Generate summary
    const summary = await generatePlanSummary(filePath, planType, dates.startDate, dates.endDate);

    if (summary) {
      const updated = updatePlanWithSummary(filePath, planType, summary);
      if (updated) {
        results.suggested.push({
          file,
          type: planType,
          summary: summary.slice(0, 100) + '...',
        });
      }
    } else {
      results.skipped.push({ file, type: planType, reason: 'no data or AI unavailable' });
    }
  }

  return results;
}

/**
 * Get month start and end dates from a monthly plan file's frontmatter
 */
function getMonthDatesFromPlan(monthlyPlanPath) {
  if (!fs.existsSync(monthlyPlanPath)) return null;

  const content = fs.readFileSync(monthlyPlanPath, 'utf-8');
  const { frontmatter } = parseFrontmatter(content);

  if (!frontmatter.start_date) return null;

  const startDate = new Date(frontmatter.start_date + 'T00:00:00');
  let endDate;

  if (frontmatter.end_date) {
    endDate = new Date(frontmatter.end_date + 'T23:59:59');
  } else {
    // Default to end of month
    endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
    endDate.setHours(23, 59, 59);
  }

  return { startDate, endDate };
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
    navigation_migrated: [],
    tomorrow_updated: false,
    daily_note_linked: null,
    diary_notes_updated: null,
    habit_stats_updated: null,
    missing_weekly_plans_created: [],
  };

  // Ensure today's daily plan exists
  const dailyResult = ensureDailyPlan(planPaths.day, today);
  if (dailyResult.created) {
    metadata.plans_created.push({ type: 'day', file: dailyResult.file });
  }

  // Ensure this week's weekly plan exists
  const weeklyResult = ensureWeeklyPlan(planPaths.week, today);
  if (weeklyResult.created) {
    metadata.plans_created.push({ type: 'week', file: weeklyResult.file });
  }

  // Ensure this month's monthly plan exists
  const monthlyResult = ensureMonthlyPlan(planPaths.month, today);
  if (monthlyResult.created) {
    metadata.plans_created.push({ type: 'month', file: monthlyResult.file });
  }

  // Ensure this quarter's quarterly plan exists
  const quarterlyResult = ensureQuarterlyPlan(planPaths.quarter, today);
  if (quarterlyResult.created) {
    metadata.plans_created.push({ type: 'quarter', file: quarterlyResult.file });
  }

  // Ensure this year's yearly plan exists
  const yearlyResult = ensureYearlyPlan(planPaths.year, today);
  if (yearlyResult.created) {
    metadata.plans_created.push({ type: 'year', file: yearlyResult.file });
  }

  // Create any missing weekly plans from earliest daily plan to today
  const missingWeeklyResult = createMissingWeeklyPlans(today);
  if (missingWeeklyResult.created.length > 0) {
    metadata.missing_weekly_plans_created = missingWeeklyResult.created;

    // Update newly created weekly plans with diary notes, habit stats, and projects
    for (const weekFile of missingWeeklyResult.created) {
      const weekPath = path.join(plansDir, weekFile);
      const weekDates = getWeekDatesFromPlan(weekPath);
      if (weekDates) {
        updateWeeklyPlanWithDiaryNotes(weekPath, weekDates.startDate, weekDates.endDate);
        updateWeeklyPlanWithHabitStats(weekPath, weekDates.startDate, weekDates.endDate);
        updateWeeklyPlanWithProjects(weekPath, weekDates.startDate, weekDates.endDate);
      }
    }
  }

  // Update weekly plan with diary notes from database (current week)
  const weekDates = getWeekDatesFromPlan(planPaths.week.path);
  if (weekDates) {
    const diaryResult = updateWeeklyPlanWithDiaryNotes(
      planPaths.week.path,
      weekDates.startDate,
      weekDates.endDate
    );
    if (diaryResult.updated) {
      metadata.diary_notes_updated = diaryResult.counts;
    }

    // Update habit stats for current week
    const habitResult = updateWeeklyPlanWithHabitStats(
      planPaths.week.path,
      weekDates.startDate,
      weekDates.endDate
    );
    if (habitResult.updated) {
      metadata.habit_stats_updated = habitResult.stats;
    }

    // Update projects for current week
    const weekProjectsResult = updateWeeklyPlanWithProjects(
      planPaths.week.path,
      weekDates.startDate,
      weekDates.endDate
    );
    if (weekProjectsResult.updated) {
      metadata.weekly_projects_updated = weekProjectsResult.count;
    }
  }

  // Also update the previous week's plan (entries may still be coming in)
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);
  const lastWeekPaths = getPlanFilePaths(lastWeek);
  if (fs.existsSync(lastWeekPaths.week.path)) {
    const lastWeekDates = getWeekDatesFromPlan(lastWeekPaths.week.path);
    if (lastWeekDates) {
      const lastWeekResult = updateWeeklyPlanWithDiaryNotes(
        lastWeekPaths.week.path,
        lastWeekDates.startDate,
        lastWeekDates.endDate
      );
      if (lastWeekResult.updated) {
        metadata.prev_week_diary_notes_updated = lastWeekResult.counts;
      }

      // Update habit stats for previous week
      const lastWeekHabitResult = updateWeeklyPlanWithHabitStats(
        lastWeekPaths.week.path,
        lastWeekDates.startDate,
        lastWeekDates.endDate
      );
      if (lastWeekHabitResult.updated) {
        metadata.prev_week_habit_stats_updated = lastWeekHabitResult.stats;
      }

      // Update projects for previous week
      const lastWeekProjectsResult = updateWeeklyPlanWithProjects(
        lastWeekPaths.week.path,
        lastWeekDates.startDate,
        lastWeekDates.endDate
      );
      if (lastWeekProjectsResult.updated) {
        metadata.prev_week_projects_updated = lastWeekProjectsResult.count;
      }
    }
  }

  // Update monthly plan with projects from database (current month)
  const monthDates = getMonthDatesFromPlan(planPaths.month.path);
  if (monthDates) {
    const projectsResult = updateMonthlyPlanWithProjects(
      planPaths.month.path,
      monthDates.startDate,
      monthDates.endDate
    );
    if (projectsResult.updated) {
      metadata.monthly_projects_updated = projectsResult.count;
    }
  }

  // Update quarterly plan with projects from database (current quarter)
  const quarterDates = getQuarterDatesFromPlan(planPaths.quarter.path);
  if (quarterDates) {
    const quarterProjectsResult = updateQuarterlyPlanWithProjects(
      planPaths.quarter.path,
      quarterDates.startDate,
      quarterDates.endDate
    );
    if (quarterProjectsResult.updated) {
      metadata.quarterly_projects_updated = quarterProjectsResult.count;
    }
  }

  // Update yearly plan with projects from database (current year)
  const yearDates = getYearDatesFromPlan(planPaths.year.path);
  if (yearDates) {
    const yearProjectsResult = updateYearlyPlanWithProjects(
      planPaths.year.path,
      yearDates.startDate,
      yearDates.endDate
    );
    if (yearProjectsResult.updated) {
      metadata.yearly_projects_updated = yearProjectsResult.count;
    }
  }

  // Update FUTURE plan files (weekly and above) that already exist
  // This ensures projects with future start dates appear in those plans
  const futurePlansUpdated = updateFuturePlanFilesWithProjects(today);
  if (futurePlansUpdated.quarterly > 0 || futurePlansUpdated.monthly > 0 || futurePlansUpdated.weekly > 0) {
    metadata.future_plans_updated = futurePlansUpdated;
  }

  // Suggest themes and goals for plans that don't have them
  // Only runs if AI is available and not in context-only mode
  if (!contextOnly) {
    const themeSuggestions = await suggestMissingThemesAndGoals(today);
    if (themeSuggestions.suggested.length > 0) {
      metadata.themes_suggested = themeSuggestions.suggested.map(s => ({
        file: s.file,
        type: s.type,
        theme: s.theme,
      }));
    }

    // Generate summaries for past plans that don't have them
    const summarySuggestions = await suggestMissingSummaries(today);
    if (summarySuggestions.suggested.length > 0) {
      metadata.summaries_suggested = summarySuggestions.suggested.map(s => ({
        file: s.file,
        type: s.type,
      }));
    }
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

  // Migrate plan files from hardcoded navigation to widget-based navigation
  const migratedNav = migrateAllNavigationToWidget();
  if (migratedNav.length > 0) {
    metadata.navigation_migrated = migratedNav;
  }

  // Generate summaries for past days that are missing them
  // Skip when CONTEXT_ONLY=true (during context gathering) to avoid slow AI calls
  if (!contextOnly) {
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

  // Build context output with guidance for the AI
  let context = '';
  if (contextParts.length > 0) {
    const guidance = `## Planning Context

This shows the user's plan hierarchy from yearly goals down to today's priorities. Use this to:
- **Align daily work with long-term goals**: When suggesting tasks or priorities, reference how they connect to weekly, monthly, quarterly, or yearly objectives
- **Help with quotidian tasks**: Acknowledge routine tasks while connecting them to bigger purposes
- **Move larger plans forward**: Look for opportunities to advance projects and goals from higher-level plans
- **Maintain context**: The themes and priorities reflect what the user has decided is important for each time period

When the user asks what to work on, consider both their immediate daily priorities AND how to make progress on longer-term goals.`;

    context = `${guidance}\n\n${contextParts.join('\n\n---\n\n')}`;
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
