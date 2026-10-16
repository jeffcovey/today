/**
 * Where a day's role reports live: the daily plan file for that date.
 */

import path from 'path';
import { getTimezone } from '../../src/config.js';
import { getDailyPlanRelativePath } from '../../src/plan-utils.js';

export function todayDateString(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: process.env.TZ || getTimezone() });
}

/** Vault-relative path of today's daily plan, e.g. "plans/2026_Q4_10_W42_16.md". */
export function todayPlanRelativePath(now = new Date()) {
  return getDailyPlanRelativePath(todayDateString(now));
}

/** Absolute path of the daily plan that holds the role blocks for a date. */
export function rolePlanFile(vaultPath, dateStr) {
  return path.join(vaultPath, getDailyPlanRelativePath(dateStr));
}

/**
 * The least a daily plan needs when a role reports on a day the plans
 * plugin never templated: front matter the plugin recognises, and the
 * title. The plugin's maintenance leaves such a file alone.
 */
export function minimalDailyPlan(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const display = new Date(year, month - 1, day, 12).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  return `---\ncssclasses: plan\ndaily_summary:\nobsidianUIMode: preview\n---\n\n# Daily Plan - ${display}\n\n`;
}
