/**
 * Date utility functions using date-fns library.
 * Provides standardized date formatting and calculations.
 */

import { format, getWeek, getQuarter, startOfWeek, endOfWeek, startOfDay as dfStartOfDay, addDays, subSeconds, parseISO } from 'date-fns';
import { TZDate } from '@date-fns/tz';
import { getFullConfig } from './config.js';

/**
 * Format a date as YYYY-MM-DD.
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Formatted date string
 */
export function formatDate(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'yyyy-MM-dd');
}

/**
 * Format a date as YYYY-MM-DD HH:mm:ss.
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Formatted datetime string
 */
export function formatDateTime(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Get ISO week number (1-53).
 * @param {Date|string} date - Date object or ISO string
 * @returns {number} Week number
 */
export function getWeekNumber(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return getWeek(d, { weekStartsOn: 1 }); // Monday start
}

/**
 * Get quarter number (1-4).
 * @param {Date|string} date - Date object or ISO string
 * @returns {number} Quarter number
 */
export function getQuarterNumber(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return getQuarter(d);
}

/**
 * Get quarter string (Q1, Q2, Q3, Q4).
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Quarter string
 */
export function getQuarterString(date) {
  return `Q${getQuarterNumber(date)}`;
}

/**
 * Get date components for plan file naming.
 * @param {Date|string} date - Date object or ISO string
 * @returns {Object} Object with year, quarter, month, week, day
 */
export function getDateComponents(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return {
    year: format(d, 'yyyy'),
    quarter: getQuarterString(d),
    month: format(d, 'MM'),
    week: String(getWeekNumber(d)).padStart(2, '0'),
    day: format(d, 'dd'),
  };
}

/**
 * Get the start of the week (Monday).
 * @param {Date|string} date - Date object or ISO string
 * @returns {Date} Start of week
 */
export function getWeekStart(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return startOfWeek(d, { weekStartsOn: 1 });
}

/**
 * Get the end of the week (Sunday).
 * @param {Date|string} date - Date object or ISO string
 * @returns {Date} End of week
 */
export function getWeekEnd(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return endOfWeek(d, { weekStartsOn: 1 });
}

/**
 * Add days to a date.
 * @param {Date|string} date - Date object or ISO string
 * @param {number} days - Number of days to add (can be negative)
 * @returns {Date} New date
 */
export function addDaysToDate(date, days) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return addDays(d, days);
}

/**
 * Format month as two-digit string (01-12).
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Two-digit month
 */
export function getMonth(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'MM');
}

/**
 * Format day as two-digit string (01-31).
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Two-digit day
 */
export function getDay(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'dd');
}

/**
 * Get year as string.
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Four-digit year
 */
export function getYear(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'yyyy');
}

/**
 * Format a date for display (e.g., "December 9, 2025").
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Human-readable date
 */
export function formatDisplayDate(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'MMMM d, yyyy');
}

/**
 * Format a date for short display (e.g., "Dec 9").
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Short date string
 */
export function formatShortDate(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'MMM d');
}

/**
 * Get day of week name (e.g., "Monday").
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Day name
 */
export function getDayName(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'EEEE');
}

/**
 * Get short day of week name (e.g., "Mon").
 * @param {Date|string} date - Date object or ISO string
 * @returns {string} Short day name
 */
export function getShortDayName(date) {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'EEE');
}

// =============================================================================
// Timezone-aware functions
// =============================================================================

/**
 * Get the configured timezone from config.toml.
 * Falls back to system timezone if not configured.
 * @returns {string} IANA timezone identifier (e.g., "America/New_York")
 */
export function getConfiguredTimezone() {
  try {
    const config = getFullConfig();
    return config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

/**
 * Get current time in the configured timezone.
 * @param {string} [timezone] - Optional timezone override
 * @returns {TZDate} Current time as TZDate
 */
export function getCurrentTime(timezone) {
  const tz = timezone || getConfiguredTimezone();
  return new TZDate(new Date(), tz);
}

/**
 * Format a date as ISO 8601 with timezone offset (e.g., "2025-12-10T19:31:32-05:00").
 * This is the format used by time tracking entries.
 * @param {Date|string} date - Date object or ISO string
 * @param {string} [timezone] - Optional timezone (defaults to configured timezone)
 * @returns {string} ISO 8601 datetime with timezone offset
 */
export function formatISO8601(date, timezone) {
  const tz = timezone || getConfiguredTimezone();
  const d = typeof date === 'string' ? parseISO(date) : date;
  const tzDate = new TZDate(d, tz);
  return format(tzDate, "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/**
 * Get current time formatted as ISO 8601 with timezone offset.
 * @param {string} [timezone] - Optional timezone override
 * @returns {string} Current time as ISO 8601 string
 */
export function getCurrentTimeISO(timezone) {
  const tz = timezone || getConfiguredTimezone();
  const now = new TZDate(new Date(), tz);
  return format(now, "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/**
 * Get today's date as YYYY-MM-DD in the configured timezone.
 * @param {string} [timezone] - Optional timezone override
 * @returns {string} Today's date
 */
export function getTodayDate(timezone) {
  const tz = timezone || getConfiguredTimezone();
  const now = new TZDate(new Date(), tz);
  return format(now, 'yyyy-MM-dd');
}

/**
 * Subtract seconds from a date in a timezone.
 * Useful for calculating start time from duration.
 * @param {Date|string} date - Date object or ISO string
 * @param {number} seconds - Number of seconds to subtract
 * @param {string} [timezone] - Optional timezone override
 * @returns {string} Resulting time as ISO 8601 string
 */
export function subtractSecondsISO(date, seconds, timezone) {
  const tz = timezone || getConfiguredTimezone();
  const d = typeof date === 'string' ? parseISO(date) : date;
  const tzDate = new TZDate(d, tz);
  const result = subSeconds(tzDate, seconds);
  return format(new TZDate(result, tz), "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/**
 * Get the start of a week range (7 days ago) in the configured timezone.
 * @param {string} [timezone] - Optional timezone override
 * @returns {string} Date 7 days ago as YYYY-MM-DD
 */
export function getWeekAgoDate(timezone) {
  const tz = timezone || getConfiguredTimezone();
  const now = new TZDate(new Date(), tz);
  const weekAgo = addDays(now, -7);
  return format(new TZDate(weekAgo, tz), 'yyyy-MM-dd');
}

/**
 * Format a time for display (e.g., "7:31 PM").
 * @param {Date|string} date - Date object or ISO string
 * @param {string} [timezone] - Optional timezone override
 * @returns {string} Formatted time
 */
export function formatTime(date, timezone) {
  const tz = timezone || getConfiguredTimezone();
  const d = typeof date === 'string' ? parseISO(date) : date;
  const tzDate = new TZDate(d, tz);
  return format(tzDate, 'h:mm a');
}

/**
 * Format a time range for display (e.g., "7:31 PM - 8:45 PM").
 * @param {Date|string} start - Start time
 * @param {Date|string} end - End time
 * @param {string} [timezone] - Optional timezone override
 * @returns {string} Formatted time range
 */
export function formatTimeRange(start, end, timezone) {
  return `${formatTime(start, timezone)} - ${formatTime(end, timezone)}`;
}

/**
 * Get the start of today (midnight) in the configured timezone as a Unix timestamp.
 * @param {string} [timezone] - Optional timezone override
 * @returns {number} Unix timestamp in milliseconds for start of today
 */
export function getStartOfDayTimestamp(timezone) {
  const tz = timezone || getConfiguredTimezone();
  const now = new TZDate(new Date(), tz);
  const startOfToday = dfStartOfDay(now);
  return new TZDate(startOfToday, tz).getTime();
}

/**
 * Format a date/time for full display (e.g., "Thursday, December 11, 2025 at 10:30 AM EST").
 * @param {Date|string} date - Date object or ISO string
 * @param {string} [timezone] - Optional timezone override
 * @returns {string} Formatted full datetime string
 */
export function formatFullDateTime(date, timezone) {
  const tz = timezone || getConfiguredTimezone();
  const d = typeof date === 'string' ? parseISO(date) : date;
  const tzDate = new TZDate(d, tz);
  return format(tzDate, "EEEE, MMMM d, yyyy 'at' h:mm a zzz");
}

/**
 * Get timezone offset string (e.g., "-05:00").
 * @param {Date|string} [date] - Optional date (defaults to now)
 * @param {string} [timezone] - Optional timezone override
 * @returns {string} Timezone offset
 */
export function getTimezoneOffset(date, timezone) {
  const tz = timezone || getConfiguredTimezone();
  const d = date ? (typeof date === 'string' ? parseISO(date) : date) : new Date();
  const tzDate = new TZDate(d, tz);
  return format(tzDate, 'xxx');
}

// =============================================================================
// SQL helpers for timezone-aware timestamps
// =============================================================================

/**
 * Generate SQL snippet for extracting local date from ISO timestamps.
 *
 * SQLite's date() function converts timezone-aware timestamps to UTC before
 * extracting the date, which causes entries after 7 PM Eastern to appear as
 * the next day. This helper extracts the date portion directly from the
 * ISO string, preserving the local date.
 *
 * @param {string} column - SQL column name containing ISO timestamp
 * @returns {string} SQL snippet for extracting local date (YYYY-MM-DD)
 *
 * @example
 * // Instead of: WHERE date(start_time) = '2025-12-29'
 * // Use: WHERE ${sqlLocalDate('start_time')} = '2025-12-29'
 */
export function sqlLocalDate(column) {
  return `SUBSTR(${column}, 1, 10)`;
}
