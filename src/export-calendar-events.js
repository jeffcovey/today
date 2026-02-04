/**
 * Calendar Events Export Service
 * Exports upcoming calendar events from database to JSON for Obsidian widget
 */

import { getDatabase } from './database-service.js';
import { getFullConfig } from './config.js';
import { parseISO, format } from 'date-fns';
import { TZDate } from '@date-fns/tz';
import fs from 'fs';
import path from 'path';

/**
 * Convert database time to proper timezone-aware ISO string with offset
 * @param {string} dateTime - Database datetime string
 * @param {string} timezone - Event timezone (e.g., "America/New_York")
 * @param {string} defaultTimezone - Default timezone from config
 * @returns {string} ISO string with timezone offset (e.g., "2026-02-04T08:00:00-05:00")
 */
function convertDatabaseTime(dateTime, timezone, defaultTimezone) {
  if (!dateTime) return null;

  // Use the event's timezone if available, otherwise fall back to default
  const tz = timezone || defaultTimezone;

  // Parse the database time and interpret it in the event's timezone
  const parsed = parseISO(dateTime);
  const tzDate = new TZDate(parsed, tz);

  // Return as ISO string WITH timezone offset for unambiguous interpretation
  return format(tzDate, "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/**
 * Export upcoming events to JSON file for Obsidian widget
 * @param {string} vaultPath - Path to the vault directory
 * @param {number} daysAhead - Number of days ahead to export (default: 30)
 */
export async function exportUpcomingEvents(vaultPath, daysAhead = 30) {
  try {
    const db = getDatabase();
    const config = getFullConfig();
    const timezone = config.timezone || 'UTC';

    // Calculate date range
    const today = new Date();
    const endDate = new Date();
    endDate.setDate(today.getDate() + daysAhead);

    const todayStr = today.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // Query events from database
    const events = db.all(`
      SELECT
        id,
        source,
        calendar_name,
        title,
        start_date,
        end_date,
        start_timezone,
        end_timezone,
        location,
        description,
        all_day
      FROM events
      WHERE start_date >= ? AND start_date <= ?
      ORDER BY start_date ASC
    `, todayStr, endDateStr);

    // Transform events to format expected by widget
    const transformedEvents = events.map(event => ({
      id: event.id,
      title: event.title || 'Untitled Event',
      start: convertDatabaseTime(event.start_date, event.start_timezone, timezone),
      end: convertDatabaseTime(event.end_date, event.end_timezone, timezone),
      location: event.location || '',
      description: event.description || '',
      calendar: event.calendar_name || event.source,
      source: event.source,
      isAllDay: Boolean(event.all_day)
    }));

    // Create export object
    const exportData = {
      exported_at: new Date().toISOString(),
      timezone: timezone,
      date_range: {
        start: todayStr,
        end: endDateStr,
        days_ahead: daysAhead
      },
      count: transformedEvents.length,
      entries: transformedEvents
    };

    // Ensure logs directory exists
    const logsDir = path.join(vaultPath, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Write to JSON file
    const exportPath = path.join(logsDir, 'upcoming-events.json');
    fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));

    console.log(`✓ Exported ${transformedEvents.length} upcoming events to ${exportPath}`);
    return exportPath;

  } catch (error) {
    console.error('Error exporting calendar events:', error.message);
    throw error;
  }
}

/**
 * CLI entry point for testing
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const vaultPath = process.argv[2] || './vault';
  const daysAhead = parseInt(process.argv[3]) || 30;

  exportUpcomingEvents(vaultPath, daysAhead)
    .then(path => console.log(`Events exported to: ${path}`))
    .catch(error => {
      console.error('Export failed:', error.message);
      process.exit(1);
    });
}