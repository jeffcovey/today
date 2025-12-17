#!/usr/bin/env node

/**
 * Time Blocking Calendar Cleanup
 *
 * NOTE: This was extracted from bin/sync for migration to a plugin.
 * Deletes past events from a time-blocking calendar, keeping recent days
 * for review of planned vs actual.
 *
 * Currently wraps: bin/calendar cleanup <calendar-id> <days-to-keep>
 *
 * TODO: Migrate to a plugin that:
 * - Uses google-calendar plugin infrastructure
 * - Configurable calendar ID and retention period
 * - Could be a "maintenance" type plugin or extension of google-calendar
 */

import { execSync } from 'child_process';

function cleanupTimeBlocking() {
  console.log('Cleaning up Time Blocking calendar...');

  // Get Time Blocking calendar ID from environment
  const timeBlockingCalendar = process.env.TIME_BLOCKING_CALENDAR_ID ||
    'e1jdfoki06hfrg8kh55mn9kvvs@group.calendar.google.com';

  try {
    // Keep yesterday (1 day) so we can review planned vs. actual
    execSync(`bin/calendar cleanup "${timeBlockingCalendar}" 1`, { stdio: 'pipe' });
    console.log('Time blocking cleaned');
    return true;
  } catch (error) {
    console.error(`Time blocking cleanup failed: ${error.message}`);
    return false;
  }
}

// Run if called directly
cleanupTimeBlocking();
