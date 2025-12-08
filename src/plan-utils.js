/**
 * Plan utilities - shared functions for daily planning and review
 *
 * Extracted from bin/today for DRY compliance and testability.
 */

import fs from 'fs';
import path from 'path';

// ============================================================================
// Date Utilities
// ============================================================================

/**
 * Calculate quarter string from month (1-12)
 * @param {number} month - Month number (1-12)
 * @returns {string} Quarter string like "Q1", "Q2", etc.
 */
export function getQuarter(month) {
  return `Q${Math.floor((month - 1) / 3) + 1}`;
}

/**
 * Calculate ISO week number from a date
 * @param {Date} date - The date to calculate week for
 * @returns {number} ISO week number (1-53)
 */
export function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Get date components for plan file naming
 * @param {Date} [date=new Date()] - Target date
 * @returns {{year: number, month: number, day: number, week: number, quarter: string}}
 */
export function getDateComponents(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const week = getISOWeek(date);
  const quarter = getQuarter(month);
  return { year, month, day, week, quarter };
}

// ============================================================================
// Stage System
// ============================================================================

/**
 * Stage mapping - defines the theme for each day of the week
 */
export const STAGE_MAPPING = {
  'Monday': ['Front Stage', 'Meetings, calls, support, emails'],
  'Wednesday': ['Front Stage', 'Meetings, calls, support, emails'],
  'Saturday': ['Front Stage', 'Meetings, calls, support, emails'],
  'Thursday': ['Back Stage', 'Maintenance, bills, bug fixes, organizing'],
  'Sunday': ['Back Stage', 'Maintenance, bills, bug fixes, organizing'],
  'Tuesday': ['Off Stage', 'Personal time, nature, friends, reading'],
  'Friday': ['Off Stage', 'Personal time, nature, friends, reading'],
};

/**
 * Get stage info for a given day
 * @param {string|Date} dayOrDate - Day name ("Monday") or Date object
 * @returns {[string, string]} [stageName, stageDescription]
 */
export function getStageInfo(dayOrDate) {
  let dayOfWeek;
  if (dayOrDate instanceof Date) {
    dayOfWeek = dayOrDate.toLocaleDateString('en-US', { weekday: 'long' });
  } else {
    dayOfWeek = dayOrDate;
  }
  return STAGE_MAPPING[dayOfWeek] || ['Unknown', 'Unknown'];
}

// ============================================================================
// Plan File Paths
// ============================================================================

/**
 * Build a daily plan file path
 * @param {{year: number, month: number, day: number, week: number, quarter: string}} components
 * @returns {string} Path like "vault/plans/2025_Q4_12_W49_07.md"
 */
export function getDailyPlanPath(components) {
  const { year, month, day, week, quarter } = components;
  return `vault/plans/${year}_${quarter}_${String(month).padStart(2, '0')}_W${String(week).padStart(2, '0')}_${String(day).padStart(2, '0')}.md`;
}

/**
 * Build a plan file path for a given date
 * @param {Date} [date=new Date()] - Target date
 * @returns {string} Path to the daily plan file
 */
export function getPlanFilePath(date = new Date()) {
  return getDailyPlanPath(getDateComponents(date));
}

/**
 * Get the hierarchy of plan files (year, quarter, month, week)
 * @param {{year: number, month: number, week: number, quarter: string}} components
 * @returns {Array<{path: string, type: string, label: string}>}
 */
export function getPlanFileHierarchy(components) {
  const { year, month, week, quarter } = components;
  return [
    {
      path: `vault/plans/${year}_00.md`,
      type: 'year',
      label: 'Year plan'
    },
    {
      path: `vault/plans/${year}_${quarter}_00.md`,
      type: 'quarter',
      label: 'Quarter plan'
    },
    {
      path: `vault/plans/${year}_${quarter}_${String(month).padStart(2, '0')}_00.md`,
      type: 'month',
      label: 'Month plan'
    },
    {
      path: `vault/plans/${year}_${quarter}_${String(month).padStart(2, '0')}_W${String(week).padStart(2, '0')}_00.md`,
      type: 'week',
      label: 'Week plan'
    },
  ];
}

// ============================================================================
// File System Utilities
// ============================================================================

/**
 * Recursively find markdown files in a directory
 * @param {string} dir - Directory to search
 * @param {Object} [options={}] - Options
 * @param {string[]} [options.excludeDirs=['.', 'templates']] - Directory prefixes/names to exclude
 * @param {string} [options.extension='.md'] - File extension to match
 * @returns {string[]} Array of file paths
 */
export function walkMarkdownFiles(dir, options = {}) {
  const {
    excludeDirs = ['.', 'templates'],
    extension = '.md'
  } = options;

  const files = [];

  const walk = (currentDir) => {
    if (!fs.existsSync(currentDir)) return;

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      // Check exclusions
      const shouldExclude = excludeDirs.some(exc =>
        exc === '.' ? entry.name.startsWith('.') : entry.name === exc
      );
      if (shouldExclude) continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(extension)) {
        files.push(fullPath);
      }
    }
  };

  walk(dir);
  return files;
}

// ============================================================================
// Task Parsing Utilities
// ============================================================================

/**
 * Priority emoji patterns for high priority detection
 */
export const HIGH_PRIORITY_EMOJIS = ['🔺', '⏫', '🔴'];

/**
 * Check if a task line is high priority
 * @param {string} taskLine - The task line text
 * @returns {boolean}
 */
export function isHighPriority(taskLine) {
  return HIGH_PRIORITY_EMOJIS.some(emoji => taskLine.includes(emoji));
}

/**
 * Extract date from a task line
 * @param {string} taskLine - The task line text
 * @returns {string|null} Date string in YYYY-MM-DD format or null
 */
export function extractTaskDate(taskLine) {
  const dateMatch = taskLine.match(/[📅⏳]\s*(\d{4}-\d{2}-\d{2})/);
  return dateMatch ? dateMatch[1] : null;
}

/**
 * Parse uncompleted tasks from markdown content
 * @param {string} content - Markdown content
 * @returns {string[]} Array of task lines
 */
export function parseUncompletedTasks(content) {
  const taskRegex = /^- \[ \].*$/gm;
  return content.match(taskRegex) || [];
}

/**
 * Get task statistics from markdown files
 * @param {string} vaultDir - Directory to scan
 * @returns {{total: number, overdue: number, highPriority: number}}
 */
export function getTaskStatistics(vaultDir = 'vault') {
  const stats = { total: 0, overdue: 0, highPriority: 0 };
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const mdFiles = walkMarkdownFiles(vaultDir);

  for (const filePath of mdFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const tasks = parseUncompletedTasks(content);
      stats.total += tasks.length;

      for (const task of tasks) {
        if (isHighPriority(task)) {
          stats.highPriority++;
        }

        const dateStr = extractTaskDate(task);
        if (dateStr) {
          const taskDate = new Date(dateStr);
          if (taskDate < today) {
            stats.overdue++;
          }
        }
      }
    } catch {
      continue;
    }
  }

  return stats;
}

// ============================================================================
// JSON Parsing Utilities
// ============================================================================

/**
 * Extract JSON from a response that may contain markdown code blocks
 * @param {string} text - Response text that may contain JSON
 * @returns {any} Parsed JSON object
 * @throws {Error} If JSON cannot be extracted or parsed
 */
export function extractJsonFromResponse(text) {
  let jsonStr;

  // Try ```json block first
  if (text.includes('```json')) {
    jsonStr = text.split('```json')[1].split('```')[0].trim();
  }
  // Try generic ``` block
  else if (text.includes('```')) {
    jsonStr = text.split('```')[1].split('```')[0].trim();
  }
  // Try to find JSON object directly
  else if (text.includes('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (end > start) {
      jsonStr = text.slice(start, end + 1);
    }
  }

  if (!jsonStr) {
    jsonStr = text.trim();
  }

  return JSON.parse(jsonStr);
}

// ============================================================================
// Template Processing
// ============================================================================

/**
 * Get template variables for a given date
 * @param {Date} date - Target date
 * @returns {Object} Template variable replacements
 */
export function getTemplateVariables(date) {
  const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long' });
  const [stageTheme, stageFocus] = getStageInfo(dayOfWeek);

  return {
    '{{DAY_OF_WEEK}}': dayOfWeek,
    '{{MONTH_NAME}}': date.toLocaleDateString('en-US', { month: 'long' }),
    '{{DAY}}': String(date.getDate()),
    '{{YEAR}}': String(date.getFullYear()),
    '{{FULL_DATE}}': date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    '{{STAGE_THEME}}': stageTheme,
    '{{STAGE_FOCUS}}': stageFocus,
    '{{PRIORITIES_FROM_DATABASE}}': '',
    '{{MORNING_TIME_BLOCKS}}': '',
    '{{AFTERNOON_TIME_BLOCKS}}': '',
    '{{EVENING_TIME_BLOCKS}}': '',
  };
}

/**
 * Apply template variables to content
 * @param {string} content - Template content
 * @param {Object} variables - Key-value pairs to replace
 * @returns {string} Processed content
 */
export function applyTemplateVariables(content, variables) {
  let result = content;
  for (const [key, value] of Object.entries(variables)) {
    result = result.split(key).join(value);
  }
  return result;
}
