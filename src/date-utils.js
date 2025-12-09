/**
 * Date utility functions using date-fns library.
 * Provides standardized date formatting and calculations.
 */

import { format, getWeek, getQuarter, startOfWeek, endOfWeek, addDays, parseISO } from 'date-fns';

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
