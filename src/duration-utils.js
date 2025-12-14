/**
 * Duration parsing and formatting utilities.
 * Used by time tracking, calendar events, and any duration-based input.
 */

/**
 * Parse natural language duration to minutes.
 * Supports various formats like "20m", "2h", "1.5h", "2h30m".
 * @param {string} input - Duration string
 * @returns {number} Duration in minutes (0 if unparseable)
 */
export function parseDuration(input) {
  if (!input) return 0;
  input = String(input).toLowerCase().replace(/\s+/g, '');

  // Decimal hours (e.g., "1.5h", "0.5hours")
  const decimalHours = input.match(/^(\d+\.?\d*)h(ours?)?$/);
  if (decimalHours) {
    return Math.floor(parseFloat(decimalHours[1]) * 60);
  }

  // Hours + minutes (e.g., "2h30m", "1h15m")
  const hoursMinutes = input.match(/(\d+)h(ours?)?(\d+)m(inutes?|ins?)?/);
  if (hoursMinutes) {
    return parseInt(hoursMinutes[1]) * 60 + parseInt(hoursMinutes[3]);
  }

  // Just hours (e.g., "2h", "2hours")
  const justHours = input.match(/^(\d+)h(ours?)?$/);
  if (justHours) {
    return parseInt(justHours[1]) * 60;
  }

  // Just minutes (e.g., "20m", "35minutes")
  const justMinutes = input.match(/^(\d+)m(inutes?|ins?)?$/);
  if (justMinutes) {
    return parseInt(justMinutes[1]);
  }

  return 0;
}

/**
 * Format duration in seconds to human readable string.
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted string like "2h 30m" or "45m"
 */
export function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Format duration in minutes to human readable string.
 * @param {number} minutes - Duration in minutes
 * @returns {string} Formatted string like "2h 30m" or "45m"
 */
export function formatDurationMinutes(minutes) {
  return formatDuration(minutes * 60);
}

/**
 * Calculate duration in minutes between two timestamps.
 * @param {string|Date} start - Start time (ISO string or Date)
 * @param {string|Date} end - End time (ISO string or Date)
 * @returns {number} Duration in minutes
 */
export function calculateDurationMinutes(start, end) {
  try {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    return Math.floor((endMs - startMs) / 60000);
  } catch {
    return 0;
  }
}
