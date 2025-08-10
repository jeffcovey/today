#!/usr/bin/env node
/**
 * Common dotenvx loader for Node.js scripts
 * Import this to auto-use dotenvx if available
 */

import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';

/**
 * Check if dotenvx encryption is present
 */
export function hasDotenvxEncryption() {
  return existsSync('.env.vault') || 
    (existsSync('.env') && readFileSync('.env', 'utf8').includes('DOTENV_PUBLIC_KEY'));
}

/**
 * Check if dotenvx is installed
 */
export function hasDotenvxInstalled() {
  return existsSync('node_modules/@dotenvx/dotenvx/src/cli/dotenvx.js');
}

/**
 * Auto-restart with dotenvx if available
 * Call this at the start of any Node script that needs env vars
 * 
 * @param {string} scriptPath - The path to the current script (usually process.argv[1])
 * @returns {boolean} - Returns true if restarted with dotenvx, false otherwise
 */
export function autoDotenvx(scriptPath = process.argv[1]) {
  // Skip if already running under dotenvx
  if (process.env.DOTENVX_RUNNING) {
    return false;
  }
  
  if (hasDotenvxEncryption() && hasDotenvxInstalled()) {
    // Get original args (without duplicates)
    const args = process.argv.slice(2);
    
    // Re-run with dotenvx
    const result = spawnSync('npx', ['dotenvx', 'run', '--quiet', '--', 'node', scriptPath, ...args], {
      stdio: 'inherit',
      env: { ...process.env, DOTENVX_RUNNING: '1' }
    });
    process.exit(result.status || 0);
  }
  
  return false;
}

// Auto-execute if this is the main module (for backwards compatibility)
if (import.meta.url === `file://${process.argv[1]}`) {
  autoDotenvx();
}