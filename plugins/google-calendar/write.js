#!/usr/bin/env node

// Create, update, or delete events in Google Calendar
// Input: JSON on stdin with action and event details
// Output: JSON with result

import { google } from 'googleapis';
import readline from 'readline';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const calendarId = config.calendar_id;

async function main() {
  // Read input from stdin
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let inputData = '';
  for await (const line of rl) {
    inputData += line;
  }

  if (!inputData) {
    console.log(JSON.stringify({ success: false, error: 'No input provided' }));
    return;
  }

  const input = JSON.parse(inputData);
  const { action, event } = input;

  if (!calendarId) {
    console.log(JSON.stringify({ success: false, error: 'No calendar_id configured' }));
    return;
  }

  // Get service account credentials
  const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountKey) {
    console.log(JSON.stringify({ success: false, error: 'GOOGLE_SERVICE_ACCOUNT_KEY not set' }));
    return;
  }

  try {
    const keyJson = Buffer.from(serviceAccountKey, 'base64').toString('utf-8');
    const credentials = JSON.parse(keyJson);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    let result;

    switch (action) {
      case 'create':
        result = await createEvent(calendar, calendarId, event);
        break;
      case 'update':
        result = await updateEvent(calendar, calendarId, event);
        break;
      case 'delete':
        result = await deleteEvent(calendar, calendarId, event.id);
        break;
      default:
        result = { success: false, error: `Unknown action: ${action}` };
    }

    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error.message }));
  }
}

async function createEvent(calendar, calendarId, event) {
  const googleEvent = buildGoogleEvent(event);

  const response = await calendar.events.insert({
    calendarId,
    resource: googleEvent,
  });

  return {
    success: true,
    event_id: response.data.id,
    html_link: response.data.htmlLink
  };
}

async function updateEvent(calendar, calendarId, event) {
  if (!event.id) {
    return { success: false, error: 'Event ID required for update' };
  }

  const googleEvent = buildGoogleEvent(event);

  const response = await calendar.events.patch({
    calendarId,
    eventId: event.id,
    resource: googleEvent,
  });

  return {
    success: true,
    event_id: response.data.id,
    html_link: response.data.htmlLink
  };
}

async function deleteEvent(calendar, calendarId, eventId) {
  if (!eventId) {
    return { success: false, error: 'Event ID required for delete' };
  }

  await calendar.events.delete({
    calendarId,
    eventId,
  });

  return { success: true, deleted: eventId };
}

function buildGoogleEvent(event) {
  const googleEvent = {};

  if (event.title) googleEvent.summary = event.title;
  if (event.location) googleEvent.location = event.location;
  if (event.description) googleEvent.description = event.description;

  // Handle start/end times
  if (event.start_date) {
    if (event.all_day) {
      googleEvent.start = { date: event.start_date.slice(0, 10) };
    } else {
      googleEvent.start = {
        dateTime: event.start_date,
        timeZone: event.start_timezone || event.timezone || 'America/New_York'
      };
    }
  }

  if (event.end_date) {
    if (event.all_day) {
      googleEvent.end = { date: event.end_date.slice(0, 10) };
    } else {
      googleEvent.end = {
        dateTime: event.end_date,
        timeZone: event.end_timezone || event.timezone || 'America/New_York'
      };
    }
  }

  // Use calendar's default notifications
  googleEvent.reminders = { useDefault: true };

  return googleEvent;
}

main().catch(err => {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
