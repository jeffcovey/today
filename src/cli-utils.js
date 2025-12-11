/**
 * CLI utilities for parsing arguments and displaying errors.
 * Shared across all binary commands.
 */

import chalk from 'chalk';

/**
 * Parse command line arguments into a structured object.
 * Handles --long-options, -s short options, commands, and positional args.
 *
 * @param {string[]} [argv] - Arguments to parse (defaults to process.argv.slice(2))
 * @returns {Object} Parsed arguments
 * @returns {string|null} return.command - The command (first non-option arg)
 * @returns {string[]} return.positional - Remaining positional arguments
 * @returns {Object} return.options - Options as key-value pairs
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    command: null,
    positional: [],
    options: {}
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        result.options[key] = argv[i + 1];
        i++;
      } else {
        result.options[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        result.options[key] = argv[i + 1];
        i++;
      } else {
        result.options[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.positional.push(arg);
    }
  }

  return result;
}

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

  console.error(chalk.red('✗') + ` ${error}`);
  console.log('');

  if (availableSources && availableSources.length > 0) {
    console.log('Available sources:');
    for (const { sourceId, enabled } of availableSources) {
      const status = enabled ? chalk.green('enabled') : chalk.gray('disabled');
      console.log(`  ${sourceId} (${status})`);
    }
  }

  console.log('');
  console.log(`Run ${chalk.cyan(configCommand)} to set up plugins.`);
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

  console.log(chalk.red('✗') + ` No sources matching "${sourceFilter}"`);
  console.log('');

  if (allSources.length > 0) {
    console.log(`Available ${pluginType} sources:`);
    for (const { sourceId, enabled } of allSources) {
      const status = enabled ? chalk.green('enabled') : chalk.gray('disabled');
      console.log(`  ${sourceId} (${status})`);
    }
  } else {
    console.log(`No ${pluginType} plugins found.`);
  }

  console.log('');
  console.log(`Run ${chalk.cyan(configCommand)} to set up plugins.`);
}
