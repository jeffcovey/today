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
  const grouped = [];
  for (const marker of sorted) {
    const representative = grouped.find(existing =>
      existing.action === marker.action &&
      existing.description === marker.description &&
      Math.abs(marker.time - existing.time) / 1000 <= dedupWindowSeconds
    );
    if (!representative) {
      grouped.push({ ...marker });
    } else if (marker.action === 'Stop' && marker.time > representative.time) {
      representative.time = marker.time;
    }
  }

  grouped.sort((a, b) => a.time - b.time);
  const latest = grouped.at(-1);
  if (latest?.action !== 'Start') return null;
  const startTime = latest.time;

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

  const markerPaths = markerFilePaths(inboxDir, filenames);
  const trashDir = path.join(inboxDir, '.trash');
  try {
    const trashEntries = await fs.readdir(trashDir, { withFileTypes: true });
    const trashDirectories = trashEntries
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(trashDir, entry.name));
    const trashFiles = await Promise.all(trashDirectories.map(async directory => {
      try {
        return markerFilePaths(directory, await fs.readdir(directory));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    }));
    markerPaths.push(...trashFiles.flat());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const contents = await Promise.all(markerPaths.map(filePath =>
    // The plugin can trash a marker between listing and reading.
    fs.readFile(filePath, 'utf8').catch(() => '')
  ));
  return findInboxSession(contents.map(parseMarker).filter(Boolean), options);
}

function markerFilePaths(directory, filenames) {
  return filenames
    .filter(name => name.startsWith('time-tracking-') && (name.endsWith('.txt') || name.endsWith('.md')))
    .map(name => path.join(directory, name));
}
