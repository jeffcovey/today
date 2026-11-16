#!/usr/bin/env node

/**
 * User Scripts Plugin
 *
 * Runs every executable file in the configured vault directory, in
 * alphabetical order. Scripts are responsible for their own idempotency.
 *
 * Scripts never run during CONTEXT_ONLY (AI context gathering) — they only
 * run on explicit syncs. In that mode the plugin instead reads the vault
 * files listed in `context_files` (typically written by these scripts) and
 * prints their contents as `context`.
 */

import { readdirSync, statSync, chmodSync, existsSync, realpathSync, openSync, readSync, closeSync } from 'fs';
import { join, resolve, relative, isAbsolute, sep } from 'path';
import { spawnSync } from 'child_process';

const config   = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const contextOnly = process.env.CONTEXT_ONLY === 'true';
const vaultPath = resolve(projectRoot, process.env.VAULT_PATH || 'vault');
const defaultScriptsDirectory = join(process.env.VAULT_PATH || 'vault', 'scripts', 'user-scripts');

// Largest slice of any one context file that goes into context.
const CONTEXT_FILE_MAX_BYTES = 8 * 1024;

/**
 * Read the configured context files. Paths are relative to the vault; any
 * that resolve outside it, directly or through a symlink, are refused, since
 * context can reach MCP callers.
 * Missing files are skipped quietly (a script may not have run yet).
 */
function isInside(root, target) {
  const rel = relative(root, target);
  return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function readContextFiles(files) {
  const parts = [];
  const notes = [];
  let realVault = null;
  try {
    realVault = realpathSync(vaultPath);
  } catch {
    return { context: '', notes };
  }
  for (const file of files) {
    const full = resolve(vaultPath, file);
    if (!isInside(vaultPath, full)) {
      notes.push(`${file}: refused, outside the vault`);
      continue;
    }
    let text;
    try {
      // Check again after following symlinks, so a link can't reach outside
      const real = realpathSync(full);
      if (!isInside(realVault, real)) {
        notes.push(`${file}: refused, links outside the vault`);
        continue;
      }
      const stat = statSync(real);
      if (!stat.isFile()) continue;
      // Read no more than the slice that goes into context
      const buffer = Buffer.alloc(Math.min(stat.size, CONTEXT_FILE_MAX_BYTES));
      const fd = openSync(real, 'r');
      let bytes;
      try {
        bytes = readSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        closeSync(fd);
      }
      text = buffer.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '');
      if (stat.size > CONTEXT_FILE_MAX_BYTES) text += `\n(${file} truncated at ${CONTEXT_FILE_MAX_BYTES / 1024} KB)`;
    } catch {
      continue;
    }
    text = text.trim();
    if (text) parts.push(text);
  }
  return { context: parts.join('\n\n'), notes };
}

// During AI context gathering: run no scripts, just report the context files
if (contextOnly) {
  const listed = config.context_files;
  const files = (Array.isArray(listed) ? listed : (typeof listed === 'string' ? [listed] : []))
    .map(f => String(f).trim())
    .filter(Boolean);
  const { context, notes } = readContextFiles(files);
  for (const note of notes) process.stderr.write(`  [user-scripts] ${note}\n`);
  console.log(JSON.stringify({
    ran: 0,
    failed: 0,
    scripts: [],
    context,
    message: 'Scripts skipped (context-only mode)'
  }));
  process.exit(0);
}

const scriptsDir = resolve(projectRoot, config.scripts_directory || defaultScriptsDirectory);
const timeoutMs  = (config.timeout_seconds || 30) * 1000;

if (!existsSync(scriptsDir)) {
  console.log(JSON.stringify({
    ran: 0,
    failed: 0,
    scripts: [],
    message: `Scripts directory not found: ${config.scripts_directory || defaultScriptsDirectory}`
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
  VAULT_PATH:      vaultPath,
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
