#!/usr/bin/env node

/**
 * Time Tracking to Calendar Sync
 *
 * NOTE: This was extracted from bin/sync for migration to a plugin.
 * Syncs time tracking entries from the database to a Google Calendar
 * so completed work appears on the calendar.
 *
 * Currently wraps: bin/calendar sync-time-tracking
 *
 * TODO: Migrate to a plugin that:
 * - Reads time_logs from database
 * - Creates events in a designated calendar (e.g., time-blocking calendar)
 * - Could be part of toggl-track plugin or a new time-tracking-calendar plugin
 * - Configurable: which calendar, how many days back to sync
 */

import { execSync } from 'child_process';

function syncTimeTrackingCalendar() {
  console.log('Syncing time tracking to calendar...');

  try {
    execSync('bin/calendar sync-time-tracking', { stdio: 'pipe' });
    console.log('Time tracking synced to calendar');
    return true;
  } catch (error) {
    console.error(`Time tracking calendar sync failed: ${error.message}`);
    return false;
  }
}

// Run if called directly
syncTimeTrackingCalendar();
