#!/usr/bin/env node

// Read diary entries from Day One JSON export
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries array
//
// Supports incremental sync: only outputs entries modified since LAST_SYNC_TIME

import fs from 'fs';
import path from 'path';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const journalFile = config.journal_file || 'vault/logs/Journal.json';
const lastSyncTime = process.env.LAST_SYNC_TIME || '';

const journalPath = path.join(projectRoot, journalFile);

// Parse last sync time for comparison
const lastSyncDate = lastSyncTime ? new Date(lastSyncTime) : null;

// Check if journal file exists
if (!fs.existsSync(journalPath)) {
  console.log(JSON.stringify({
    entries: [],
    message: `Journal file not found: ${journalFile}`
  }));
  process.exit(0);
}

// Read and parse JSON
let journalData;
try {
  const rawJSON = fs.readFileSync(journalPath, 'utf8');
  journalData = JSON.parse(rawJSON);
} catch (error) {
  // Try to repair truncated JSON
  try {
    const rawJSON = fs.readFileSync(journalPath, 'utf8');
    journalData = repairAndParseJSON(rawJSON);
  } catch (repairError) {
    console.error(JSON.stringify({
      error: `Failed to parse journal JSON: ${error.message}`
    }));
    process.exit(1);
  }
}

const rawEntries = journalData.entries || [];

// Transform entries to our schema
const entries = [];
let skippedNoText = 0;
let skippedNotModified = 0;

for (const entry of rawEntries) {
  // Skip entries without text
  if (!entry.text) {
    skippedNoText++;
    continue;
  }

  // For incremental sync, skip entries not modified since last sync
  if (lastSyncDate) {
    const entryModified = new Date(entry.modifiedDate || entry.creationDate);
    if (entryModified <= lastSyncDate) {
      skippedNotModified++;
      continue;
    }
  }

  // Build metadata object with all the rich Day One data
  const metadata = {};

  if (entry.starred) metadata.starred = true;
  if (entry.isPinned) metadata.isPinned = true;
  if (entry.tags && entry.tags.length > 0) metadata.tags = entry.tags;
  if (entry.timeZone) metadata.timeZone = entry.timeZone;
  if (entry.creationDevice) metadata.creationDevice = entry.creationDevice;
  if (entry.modifiedDate) metadata.modifiedDate = entry.modifiedDate;

  // Location data
  if (entry.location) {
    metadata.location = {
      localityName: entry.location.localityName,
      placeName: entry.location.placeName,
      administrativeArea: entry.location.administrativeArea,
      country: entry.location.country,
      latitude: entry.location.latitude,
      longitude: entry.location.longitude
    };
  }

  // Weather data
  if (entry.weather) {
    metadata.weather = {
      temperatureCelsius: entry.weather.temperatureCelsius,
      conditionsDescription: entry.weather.conditionsDescription,
      weatherCode: entry.weather.weatherCode,
      relativeHumidity: entry.weather.relativeHumidity,
      windSpeedKPH: entry.weather.windSpeedKPH
    };
  }

  // Day One escapes periods, brackets, etc. - unescape them
  const cleanText = entry.text
    .replace(/\\([.\[\](){}*+?^$|#!-])/g, '$1');

  entries.push({
    id: entry.uuid,
    date: entry.creationDate,
    text: cleanText,
    metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
  });
}

// Output JSON
console.log(JSON.stringify({
  entries,
  total: rawEntries.length,
  processed: entries.length,
  skipped_no_text: skippedNoText,
  skipped_not_modified: skippedNotModified,
  incremental: !!lastSyncDate
}));

/**
 * Attempt to repair truncated JSON
 */
function repairAndParseJSON(jsonString) {
  // Count brackets
  const openBraces = (jsonString.match(/{/g) || []).length;
  const closeBraces = (jsonString.match(/}/g) || []).length;
  const openBrackets = (jsonString.match(/\[/g) || []).length;
  const closeBrackets = (jsonString.match(/]/g) || []).length;

  if (openBraces === closeBraces && openBrackets === closeBrackets) {
    // Not truncated, just invalid
    throw new Error('JSON is invalid but not truncated');
  }

  // Find last complete entry
  let repairedJSON = jsonString;
  const lastCompleteEntry = jsonString.lastIndexOf('},');

  if (lastCompleteEntry > -1) {
    repairedJSON = jsonString.substring(0, lastCompleteEntry + 1);
  }

  // Close arrays and objects
  const missingBrackets = openBrackets - closeBrackets;
  const missingBraces = openBraces - closeBraces;

  for (let i = 0; i < missingBrackets; i++) {
    repairedJSON += ']';
  }
  for (let i = 0; i < missingBraces; i++) {
    repairedJSON += '}';
  }

  return JSON.parse(repairedJSON);
}
