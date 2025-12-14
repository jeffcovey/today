#!/usr/bin/env node

// Fetch and parse a public iCal calendar feed
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries and metadata

import https from 'https';
import http from 'http';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');

const calName = config.name || 'Unknown Calendar';
const calUrl = config.url;
const daysBack = config.days_back || 7;
const daysForward = config.days_forward || 90;

// Check for --date argument (for historical queries)
const dateArg = process.argv.find(arg => arg.startsWith('--date='));
const queryDate = dateArg ? dateArg.split('=')[1] : null;

// Calculate date range
let rangeStart, rangeEnd;
if (queryDate) {
  // Query specific date
  rangeStart = new Date(queryDate);
  rangeStart.setHours(0, 0, 0, 0);
  rangeEnd = new Date(queryDate);
  rangeEnd.setHours(23, 59, 59, 999);
} else {
  // Normal sync range
  const now = new Date();
  rangeStart = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  rangeEnd = new Date(now.getTime() + daysForward * 24 * 60 * 60 * 1000);
}

async function main() {
  if (!calUrl) {
    console.log(JSON.stringify({
      entries: [],
      files_processed: [],
      incremental: false,
      error: 'No URL configured'
    }));
    return;
  }

  const entries = [];

  try {
    const icalContent = await fetchUrl(calUrl);
    const events = parseICalContent(icalContent, calName);

    // Filter to date range and format for database
    for (const event of events) {
      const startDate = new Date(event.start);
      const endDate = event.end ? new Date(event.end) : startDate;

      // Skip events outside our range
      if (endDate < rangeStart || startDate > rangeEnd) continue;

      entries.push({
        id: event.id || `${event.start}-${event.title}`.substring(0, 255),
        calendar_name: calName,
        title: event.title,
        start_date: event.start,
        end_date: event.end || event.start,
        start_timezone: event.startTimeZone || null,
        end_timezone: event.endTimeZone || null,
        location: event.location || null,
        description: event.description || null,
        all_day: event.allDay || false
      });
    }
  } catch (error) {
    console.error(`Error fetching ${calName}: ${error.message}`);
  }

  console.log(JSON.stringify({
    entries,
    files_processed: [calUrl],
    incremental: false
  }));
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    const request = client.get(url, { timeout: 15000 }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function parseICalContent(content, source) {
  const events = [];
  const lines = content.split(/\r?\n/);
  let currentEvent = null;
  let inEvent = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle line continuations (lines starting with space or tab)
    while (i + 1 < lines.length && (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t'))) {
      line += lines[i + 1].substring(1);
      i++;
    }

    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      currentEvent = { source };
    } else if (line === 'END:VEVENT' && currentEvent) {
      inEvent = false;

      // Only add events with title and start date
      if (currentEvent.title && currentEvent.start) {
        events.push(currentEvent);
      }
      currentEvent = null;
    } else if (inEvent && currentEvent) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex);
        const value = line.substring(colonIndex + 1);

        if (key.startsWith('SUMMARY')) {
          currentEvent.title = unescapeIcal(value.trim());
        } else if (key.startsWith('DTSTART')) {
          if (key.includes('TZID=')) {
            const tzMatch = key.match(/TZID=([^:;]+)/);
            if (tzMatch) currentEvent.startTimeZone = tzMatch[1];
          }
          currentEvent.start = parseICalDate(value.trim());
          currentEvent.allDay = !value.includes('T');
        } else if (key.startsWith('DTEND')) {
          if (key.includes('TZID=')) {
            const tzMatch = key.match(/TZID=([^:;]+)/);
            if (tzMatch) currentEvent.endTimeZone = tzMatch[1];
          }
          currentEvent.end = parseICalDate(value.trim());
        } else if (key.startsWith('LOCATION')) {
          currentEvent.location = unescapeIcal(value.trim());
        } else if (key.startsWith('DESCRIPTION')) {
          currentEvent.description = unescapeIcal(value.trim());
        } else if (key === 'UID') {
          currentEvent.id = value.trim();
        }
      }
    }
  }

  return events;
}

function parseICalDate(dateStr) {
  // Handle both DATE (YYYYMMDD) and DATE-TIME (YYYYMMDDTHHMMSS) formats
  if (dateStr.length === 8) {
    // All-day event: YYYYMMDD
    return `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
  } else if (dateStr.includes('T')) {
    // Timed event: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
    const date = dateStr.slice(0, 8);
    const time = dateStr.slice(9, 15);
    const iso = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${time.slice(0,2)}:${time.slice(2,4)}:${time.slice(4,6)}`;
    // Preserve Z suffix for UTC times
    if (dateStr.endsWith('Z')) {
      return iso + 'Z';
    }
    return iso;
  }
  return dateStr;
}

function unescapeIcal(str) {
  return str
    .replace(/\\,/g, ',')
    .replace(/\\n/g, '\n')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
