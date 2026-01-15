#!/usr/bin/env node

/**
 * now-updates context plugin
 *
 * Maintains vault/now.md with periodic AI-generated status updates.
 * - Prepends new updates (newest first)
 * - Updates every 2 hours during waking hours
 * - One pre-wake update so it's ready when you get up
 * - No updates after bedtime
 * - Keeps 24 hours of updates, prunes older ones
 *
 * Generation happens during sync (CONTEXT_ONLY=false).
 * During context gathering (CONTEXT_ONLY=true), just returns existing content.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const contextOnly = process.env.CONTEXT_ONLY === 'true';
const isGenerating = process.env.NOW_UPDATES_GENERATING === '1';

const fileName = config.file_path || 'now.md';
const updateIntervalHours = config.update_interval_hours || 2;
const retentionHours = config.retention_hours || 24;
const updateInstructions = (config.instructions || '').trim();

// Divider pattern between updates
const DIVIDER = '\n\n---\n\n';
const UPDATE_HEADER_REGEX = /^## Update: (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;

/**
 * Read main config.toml to get wake/sleep times, timezone, and vault path
 */
function getScheduleConfig() {
  const configPath = path.join(projectRoot, 'config.toml');

  let wakeTime = '05:30';
  let bedTime = '21:30';
  let timezone = 'America/New_York';
  let vaultPath = 'vault';

  try {
    const content = fs.readFileSync(configPath, 'utf-8');

    const tzMatch = content.match(/^timezone\s*=\s*"([^"]+)"/m);
    if (tzMatch) timezone = tzMatch[1];

    const wakeMatch = content.match(/wake_time\s*=\s*"(\d{2}:\d{2})"/);
    if (wakeMatch) wakeTime = wakeMatch[1];

    const bedMatch = content.match(/bed_time\s*=\s*"(\d{2}:\d{2})"/);
    if (bedMatch) bedTime = bedMatch[1];

    const vaultMatch = content.match(/^vault_path\s*=\s*"([^"]+)"/m);
    if (vaultMatch) vaultPath = vaultMatch[1];
  } catch {
    // Use defaults
  }

  return { wakeTime, bedTime, timezone, vaultPath };
}

/**
 * Get current time in configured timezone
 */
function getCurrentTime(timezone) {
  return new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
}

/**
 * Parse HH:MM time string to { hours, minutes }
 */
function parseTime(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Check if current time is within allowed update window
 */
function isUpdateAllowed(now, wakeTime, bedTime) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const wake = parseTime(wakeTime);
  const bed = parseTime(bedTime);
  const wakeMinutes = wake.hours * 60 + wake.minutes;
  const bedMinutes = bed.hours * 60 + bed.minutes;

  // Pre-wake window: 1 hour before wake time
  const preWakeMinutes = wakeMinutes - 60;

  if (currentMinutes >= bedMinutes) {
    return { allowed: false, reason: 'after bedtime' };
  }

  if (currentMinutes < preWakeMinutes) {
    return { allowed: false, reason: 'before pre-wake window' };
  }

  return { allowed: true, reason: 'waking hours' };
}

/**
 * Parse existing updates from now.md
 */
function parseExistingUpdates(content) {
  if (!content || !content.trim()) return [];

  const updates = [];
  const sections = content.split(DIVIDER);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const match = trimmed.match(UPDATE_HEADER_REGEX);
    if (match) {
      const timestamp = new Date(match[1].replace(' ', 'T') + ':00');
      updates.push({ timestamp, content: trimmed });
    }
  }

  return updates;
}

/**
 * Check if we need a new update based on last update time
 */
function needsUpdate(updates, now, intervalHours) {
  if (updates.length === 0) return true;

  const lastUpdate = updates[0];
  const hoursSinceUpdate = (now - lastUpdate.timestamp) / (1000 * 60 * 60);

  return hoursSinceUpdate >= intervalHours;
}

/**
 * Prune updates older than retention period
 */
function pruneOldUpdates(updates, now, retentionHours) {
  const cutoff = new Date(now - retentionHours * 60 * 60 * 1000);
  return updates.filter(u => u.timestamp > cutoff);
}

/**
 * Format timestamp for update header
 */
function formatTimestamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Generate a new update by calling bin/today with instructions
 */
function generateUpdate(now) {
  if (!updateInstructions) return null;

  const timestamp = formatTimestamp(now);

  try {
    // Call bin/today with instructions, just like --focus does
    // Options must come before the request due to passThroughOptions()
    const output = execSync(
      `bin/today --non-interactive --no-sync --quiet "${updateInstructions.replace(/"/g, '\\"')}"`,
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 180000,
        env: { ...process.env, SKIP_UPDATE_CHECK: '1', SKIP_DEP_CHECK: '1', NOW_UPDATES_GENERATING: '1' }
      }
    );

    const cleanOutput = output.trim();
    if (!cleanOutput) return null;

    return `## Update: ${timestamp}\n\n${cleanOutput}`;
  } catch {
    return null;
  }
}

/**
 * Write updates back to file (newest first)
 */
function writeUpdates(updates, filePath) {
  const content = updates.map(u => u.content).join(DIVIDER);

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Main function
 */
async function main() {
  const { wakeTime, bedTime, timezone, vaultPath } = getScheduleConfig();
  const now = getCurrentTime(timezone);
  const filePath = path.join(projectRoot, vaultPath, fileName);

  const metadata = {
    currentTime: formatTimestamp(now),
    updateGenerated: false,
    reason: null,
  };

  // Read existing content
  let existingContent = '';
  if (fs.existsSync(filePath)) {
    existingContent = fs.readFileSync(filePath, 'utf-8');
  }

  let updates = parseExistingUpdates(existingContent);
  let context = existingContent.trim() || 'No updates yet.';

  // Skip update generation during context gathering (like markdown-plans does)
  // Also return empty context if we're in the middle of generating a new update
  // to avoid circular reference where AI reads old updates and propagates stale info
  if (contextOnly) {
    if (isGenerating) {
      // Don't include old updates when generating new ones - AI should use fresh data
      console.log(JSON.stringify({ context: '', metadata: { ...metadata, skipped: 'generating' } }));
    } else {
      console.log(JSON.stringify({ context, metadata }));
    }
    return;
  }

  // Check schedule
  const scheduleCheck = isUpdateAllowed(now, wakeTime, bedTime);
  metadata.reason = scheduleCheck.reason;

  if (!scheduleCheck.allowed) {
    console.log(JSON.stringify({ context, metadata }));
    return;
  }

  // Check if update is due
  if (!needsUpdate(updates, now, updateIntervalHours)) {
    metadata.reason = 'update not due yet';
    console.log(JSON.stringify({ context, metadata }));
    return;
  }

  // Generate new update
  const newUpdate = generateUpdate(now);

  if (newUpdate) {
    updates.unshift({ timestamp: now, content: newUpdate });
    metadata.updateGenerated = true;
  }

  // Prune old updates
  updates = pruneOldUpdates(updates, now, retentionHours);

  // Write back
  if (newUpdate) {
    writeUpdates(updates, filePath);
    context = updates.map(u => u.content).join(DIVIDER);
  }

  console.log(JSON.stringify({ context, metadata }));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
