/**
 * Where a day's role reports live: the daily plan file for that date.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { getAbsoluteVaultPath, getFullConfig, getTimezone } from '../../src/config.js';
import { getDailyPlanRelativePath } from '../../src/plan-utils.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function todayDateString(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: process.env.TZ || getTimezone() });
}

export function rolePlanDirectory(vaultPath, config = getFullConfig()) {
  const sources = Object.values(config.plugins?.['markdown-plans'] || {});
  const source = sources.find((item) => item?.enabled === true);
  const configured = source?.plans_directory;
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(PROJECT_ROOT, configured);
  }
  if (process.env.VAULT_PATH) {
    return path.resolve(PROJECT_ROOT, process.env.VAULT_PATH, 'plans');
  }
  return path.join(vaultPath, 'plans');
}

/** Path used by the web view for today's configured daily plan. */
export function todayPlanRelativePath(now = new Date(), vaultPath = getAbsoluteVaultPath(), config = getFullConfig()) {
  const directory = rolePlanDirectory(vaultPath, config);
  const relativeDirectory = (path.relative(vaultPath, directory) || '.').split(path.sep).join('/');
  return getDailyPlanRelativePath(todayDateString(now), relativeDirectory);
}

/** Absolute path of the daily plan that holds the role blocks for a date. */
export function rolePlanFile(vaultPath, dateStr, config = getFullConfig()) {
  const directory = rolePlanDirectory(vaultPath, config);
  const filename = path.basename(getDailyPlanRelativePath(dateStr));
  return path.join(directory, filename);
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
