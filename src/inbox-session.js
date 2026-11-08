/**
 * A session in progress according to the time-tracking markers that phone
 * automations drop in the inbox. The inbox-processing plugin turns finished
 * Start/Stop pairs into log entries; this only reads what is still under way.
 */

import fs from 'fs/promises';
import path from 'path';

// The plugin keeps an unpaired Start for 48 hours in case its Stop arrives,
// which is far too long to go on showing one as running.
export const INBOX_SESSION_MAX_HOURS = 6;

export const DEFAULT_DEDUP_WINDOW_SECONDS = 30;

export function parseMarker(content) {
  const [action, timestamp, description = ''] = content.trim().split('\n').map(line => line.trim());
  if (action !== 'Start' && action !== 'Stop') return null;
  const time = new Date(timestamp);
  if (isNaN(time.getTime())) return null;
  return { action, time, description };
}

/**
 * Only the newest marker can be running: a switch between Focus modes can
 * leave an older Start with no Stop, and that one is over.
 *
 * @returns {{description: string, startTime: Date}|null}
 */
export function findInboxSession(markers, {
  now = new Date(),
  dedupWindowSeconds = DEFAULT_DEDUP_WINDOW_SECONDS,
  maxHours = INBOX_SESSION_MAX_HOURS
} = {}) {
  const sorted = [...markers].sort((a, b) => a.time - b.time);
  const latest = sorted.at(-1);
  if (latest?.action !== 'Start') return null;

  // Several devices fire the same Start; the session began at the first.
  const startTime = sorted.find(marker =>
    marker.action === 'Start' &&
    marker.description === latest.description &&
    (latest.time - marker.time) / 1000 <= dedupWindowSeconds
  ).time;

  if (now - startTime > maxHours * 3600000) return null;
  return { description: latest.description, startTime };
}

export async function readInboxSession(inboxDir, options) {
  let filenames;
  try {
    filenames = await fs.readdir(inboxDir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const contents = await Promise.all(
    filenames
      .filter(name => name.startsWith('time-tracking-') && (name.endsWith('.txt') || name.endsWith('.md')))
      // The plugin can trash a marker between the listing and the read.
      .map(name => fs.readFile(path.join(inboxDir, name), 'utf8').catch(() => ''))
  );
  return findInboxSession(contents.map(parseMarker).filter(Boolean), options);
}
