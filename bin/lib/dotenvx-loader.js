#!/usr/bin/env node
/**
 * Common dotenvx loader for Node.js scripts
 * Import this to auto-use dotenvx if available
 */

import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';

/**
 * Check if dotenvx encryption is present AND we can decrypt it
 */
export function hasDotenvxEncryption() {
  // No .env file = nothing to load
  if (!existsSync('.env')) {
    return false;
  }

  const envContent = readFileSync('.env', 'utf8');

  // Check if file has encrypted values
  const hasEncryptedValues = envContent.includes('DOTENV_PUBLIC_KEY') || existsSync('.env.vault');

  if (!hasEncryptedValues) {
    // Plain .env file - dotenvx not needed, Node will load it normally
    return false;
  }

  // Has encrypted values - check if we have the private key to decrypt
  const hasPrivateKey = process.env.DOTENV_PRIVATE_KEY || existsSync('.env.keys');

  return hasPrivateKey;
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