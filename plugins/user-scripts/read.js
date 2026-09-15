#!/usr/bin/env node

/**
 * User Scripts Plugin
 *
 * Runs every executable file in the configured vault directory, in
 * alphabetical order. Scripts are responsible for their own idempotency.
 *
 * Skipped entirely during CONTEXT_ONLY (AI context gathering) — scripts
 * only run on explicit syncs.
 */

import { readdirSync, statSync, chmodSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const config   = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const contextOnly = process.env.CONTEXT_ONLY === 'true';

// Skip during AI context gathering
if (contextOnly) {
  console.log(JSON.stringify({ ran: 0, failed: 0, scripts: [], message: 'Skipped (context-only mode)' }));
  process.exit(0);
}

const scriptsDir = resolve(projectRoot, config.scripts_directory || 'vault/scripts/user-scripts');
const timeoutMs  = (config.timeout_seconds || 30) * 1000;

if (!existsSync(scriptsDir)) {
  console.log(JSON.stringify({
    ran: 0,
    failed: 0,
    scripts: [],
    message: `Scripts directory not found: ${config.scripts_directory || 'vault/scripts/user-scripts'}`
  }));
  process.exit(0);
}

// Collect regular files only, sorted alphabetically
const entries = readdirSync(scriptsDir, { withFileTypes: true })
  .filter(e => e.isFile() && !e.name.startsWith('.'))
  .sort((a, b) => a.name.localeCompare(b.name));

if (entries.length === 0) {
  console.log(JSON.stringify({ ran: 0, failed: 0, scripts: [], message: 'No scripts found' }));
  process.exit(0);
}

// Environment passed to every user script
const childEnv = {
  ...process.env,
  PROJECT_ROOT:    projectRoot,
  VAULT_PATH:      resolve(projectRoot, 'vault'),
  LAST_SYNC_TIME:  process.env.LAST_SYNC_TIME || '',
  SOURCE_ID:       process.env.SOURCE_ID || 'user-scripts/default',
};

const results = [];
let ran = 0;
let failed = 0;

for (const entry of entries) {
  const scriptPath = join(scriptsDir, entry.name);

  // Ensure the file is executable (sync tools like Obsidian Sync strip permissions)
  try {
    const mode = statSync(scriptPath).mode;
    if (!(mode & 0o111)) {
      chmodSync(scriptPath, mode | 0o755);
    }
  } catch (err) {
    results.push({ name: entry.name, success: false, output: '', error: `chmod failed: ${err.message}` });
    failed++;
    continue;
  }

  const result = spawnSync(scriptPath, [], {
    env: childEnv,
    timeout: timeoutMs,
    encoding: 'utf8',
    cwd: projectRoot,
  });

  const success = result.status === 0 && !result.error;
  const output  = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const error   = result.error
    ? (result.error.code === 'ETIMEDOUT' ? `Timed out after ${config.timeout_seconds || 30}s` : result.error.message)
    : (result.status !== 0 ? `Exited with code ${result.status}` : null);

  results.push({ name: entry.name, success, output, ...(error && { error }) });

  if (success) {
    ran++;
    if (output) process.stderr.write(`  [${entry.name}] ${output}\n`);
  } else {
    failed++;
    process.stderr.write(`  [${entry.name}] FAILED: ${error}${output ? '\n' + output : ''}\n`);
  }
}

const total   = results.length;
const summary = failed === 0
  ? `${ran} of ${total} script${total === 1 ? '' : 's'} ran successfully`
  : `${ran} of ${total} script${total === 1 ? '' : 's'} succeeded, ${failed} failed`;

console.log(JSON.stringify({
  cleaned: ran,   // used by the utility handler for the success count
  ran,
  failed,
  scripts: results,
  message: summary,
}));
