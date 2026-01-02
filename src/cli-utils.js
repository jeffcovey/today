/**
 * CLI utilities for displaying output and common error handling.
 * Shared across all binary commands.
 *
 * Note: All CLIs use 'commander' for argument parsing.
 */

import pc from 'picocolors';

// ============================================================================
// Color Utilities
// ============================================================================

/**
 * Color functions for CLI output.
 * Use these instead of importing chalk directly.
 *
 * @example
 * import { colors } from '../src/cli-utils.js';
 * console.log(colors.green('Success!'));
 * console.log(colors.bold(colors.blue('Header')));
 */
export const colors = {
  // Basic colors
  red: pc.red,
  green: pc.green,
  yellow: pc.yellow,
  blue: pc.blue,
  cyan: pc.cyan,
  magenta: pc.magenta,
  white: pc.white,
  gray: pc.gray,

  // Modifiers
  bold: pc.bold,
  dim: pc.dim,
  italic: pc.italic,
  underline: pc.underline,

  // Background colors
  bgRed: pc.bgRed,
  bgGreen: pc.bgGreen,
  bgYellow: pc.bgYellow,
  bgBlue: pc.bgBlue,
  bgCyan: pc.bgCyan,
  bgMagenta: pc.bgMagenta,

  // Reset
  reset: pc.reset,
};

// ============================================================================
// Output Utilities
// ============================================================================

/**
 * Print a success/status message in green.
 * @param {string} message
 */
export function printStatus(message) {
  console.log(pc.green(`✓ ${message}`));
}

/**
 * Print an error message in red to stderr.
 * @param {string} message
 */
export function printError(message) {
  console.error(pc.red(`✗ ${message}`));
}

/**
 * Print an info message in blue.
 * @param {string} message
 */
export function printInfo(message) {
  console.log(pc.blue(`ℹ ${message}`));
}

/**
 * Print a warning message in yellow.
 * @param {string} message
 */
export function printWarning(message) {
  console.log(pc.yellow(`⚠ ${message}`));
}

/**
 * Print a section header with decorative lines.
 * @param {string} message
 */
export function printHeader(message) {
  console.log('');
  console.log(pc.blue('═══════════════════════════════════════'));
  console.log(pc.bold(pc.blue(message)));
  console.log(pc.blue('═══════════════════════════════════════'));
}

// ============================================================================
// Source Error Utilities
// ============================================================================

/**
 * Display a plugin source error with available sources.
 * Used when a requested source doesn't exist or isn't enabled.
 *
 * @param {string} error - Error message
 * @param {Array<{sourceId: string, enabled: boolean}>} [availableSources] - List of available sources
 * @param {Object} [options] - Display options
 * @param {string} [options.configCommand='bin/plugins configure'] - Command to suggest for configuration
 */
export function showSourceError(error, availableSources, options = {}) {
  const { configCommand = 'bin/plugins configure' } = options;

  console.error(pc.red('✗') + ` ${error}`);
  console.log('');

  if (availableSources && availableSources.length > 0) {
    console.log('Available sources:');
    for (const { sourceId, enabled } of availableSources) {
      const status = enabled ? pc.green('enabled') : pc.gray('disabled');
      console.log(`  ${sourceId} (${status})`);
    }
  }

  console.log('');
  console.log(`Run ${pc.cyan(configCommand)} to set up plugins.`);
}

/**
 * Display a validation error for source filter with available options.
 * Used in today/week/list commands when --source doesn't match.
 *
 * @param {string} sourceFilter - The source filter that didn't match
 * @param {string} pluginType - The plugin type being queried (e.g., 'time-logs')
 * @param {Array<{sourceId: string, enabled: boolean}>} allSources - All available sources
 * @param {Object} [options] - Display options
 * @param {string} [options.configCommand='bin/plugins configure'] - Command to suggest
 */
export function showSourceFilterError(sourceFilter, pluginType, allSources, options = {}) {
  const { configCommand = 'bin/plugins configure' } = options;

  console.log(pc.red('✗') + ` No sources matching "${sourceFilter}"`);
  console.log('');

  if (allSources.length > 0) {
    console.log(`Available ${pluginType} sources:`);
    for (const { sourceId, enabled } of allSources) {
      const status = enabled ? pc.green('enabled') : pc.gray('disabled');
      console.log(`  ${sourceId} (${status})`);
    }
  } else {
    console.log(`No ${pluginType} plugins found.`);
  }

  console.log('');
  console.log(`Run ${pc.cyan(configCommand)} to set up plugins.`);
}
