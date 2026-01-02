#!/usr/bin/env node

// Fetch events from Google Calendar using service account authentication
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries and metadata

import { google } from 'googleapis';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');

const calendarId = config.calendar_id;
const daysBack = config.days_back || 7;
const daysForward = config.days_forward || 30;

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
  if (!calendarId) {
    console.log(JSON.stringify({
      entries: [],
      files_processed: [],
      incremental: false,
      error: 'No calendar_id configured'
    }));
    return;
  }

  // Get service account credentials (injected by plugin-loader from encrypted env var)
  const serviceAccountKey = config.service_account_key;
  if (!serviceAccountKey) {
    console.log(JSON.stringify({
      entries: [],
      files_processed: [],
      incremental: false,
      error: 'Google service account key not configured. Use "bin/today configure" to set up credentials.'
    }));
    return;
  }

  const entries = [];

  try {
    // Decode and parse service account key
    const keyJson = Buffer.from(serviceAccountKey, 'base64').toString('utf-8');
    const credentials = JSON.parse(keyJson);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    // Fetch events from Google Calendar
    const response = await calendar.events.list({
      calendarId: calendarId === 'primary' ? 'primary' : calendarId,
      timeMin: rangeStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
    });

    const events = response.data.items || [];

    // Get calendar name for display
    let calendarName = calendarId;
    try {
      const calInfo = await calendar.calendars.get({ calendarId });
      calendarName = calInfo.data.summary || calendarId;
    } catch {
      // Use calendarId as name if we can't fetch calendar info
    }

    // Transform events to our schema
    for (const event of events) {
      // Skip cancelled events
      if (event.status === 'cancelled') continue;

      const startDateTime = event.start?.dateTime || event.start?.date;
      const endDateTime = event.end?.dateTime || event.end?.date;

      if (!startDateTime) continue;

      const isAllDay = !event.start?.dateTime;

      entries.push({
        id: event.id,
        calendar_name: calendarName,
        title: event.summary || 'Untitled',
        start_date: formatDateTime(startDateTime, isAllDay),
        end_date: formatDateTime(endDateTime || startDateTime, isAllDay),
        start_timezone: event.start?.timeZone || null,
        end_timezone: event.end?.timeZone || null,
        location: event.location || null,
        description: event.description || null,
        all_day: isAllDay
      });
    }
  } catch (error) {
    console.error(`Error fetching calendar ${calendarId}: ${error.message}`);
    console.log(JSON.stringify({
      entries: [],
      files_processed: [],
      incremental: false,
      error: error.message
    }));
    return;
  }

  console.log(JSON.stringify({
    entries,
    files_processed: [calendarId],
    incremental: false
  }));
}

// Format datetime for database storage
function formatDateTime(dateStr, isAllDay) {
  if (isAllDay && dateStr.length === 10) {
    // All-day event: YYYY-MM-DD
    return dateStr;
  }
  // Timed event: return ISO string
  return new Date(dateStr).toISOString().replace('Z', '').slice(0, 19);
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
