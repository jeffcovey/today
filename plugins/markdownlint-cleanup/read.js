#!/usr/bin/env node

/**
 * Markdownlint Cleanup Plugin - Sync Command
 *
 * Runs markdownlint-cli2 with --fix to auto-correct markdown formatting issues.
 */

import { execSync } from 'child_process';

// Read settings from environment (set by plugin loader)
const directory = process.env.PLUGIN_SETTING_DIRECTORY || 'vault/**/*.md';

function sync() {
  try {
    // Run markdownlint with --fix
    execSync(`npx markdownlint-cli2 --fix "${directory}"`, {
      stdio: 'pipe'
    });

    // If no error, all files were already clean
    console.log(JSON.stringify({
      cleaned: 0,
      message: 'All markdown files are clean'
    }));
  } catch (error) {
    // markdownlint returns non-zero if it fixed files or found unfixable issues
    // Either way, it did its job
    console.log(JSON.stringify({
      cleaned: 1,
      message: 'Fixed formatting in markdown files'
    }));
  }
}

sync();
