/**
 * Timezone resolution using countries-and-timezones library.
 */

import ct from 'countries-and-timezones';

/**
 * Get all available IANA timezones.
 * @returns {string[]} Array of timezone names
 */
export function getAvailableTimezones() {
  return Object.keys(ct.getAllTimezones());
}

/**
 * Check if a timezone is valid.
 * @param {string} tz - Timezone string to validate
 * @returns {boolean} True if valid IANA timezone
 */
export function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Common abbreviation mappings (not in the library)
const ABBREVIATIONS = {
  'est': 'America/New_York',
  'edt': 'America/New_York',
  'cst': 'America/Chicago',
  'cdt': 'America/Chicago',
  'mst': 'America/Denver',
  'mdt': 'America/Denver',
  'pst': 'America/Los_Angeles',
  'pdt': 'America/Los_Angeles',
  'gmt': 'Etc/GMT',
  'utc': 'UTC',
  'bst': 'Europe/London',
  'cet': 'Europe/Paris',
  'cest': 'Europe/Paris',
  // Common country aliases not in the library
  'uk': 'Europe/London',
  'britain': 'Europe/London',
  'england': 'Europe/London',
  'usa': 'America/New_York',
  'us': 'America/New_York',
};

/**
 * Find a timezone that matches the query.
 * @param {string} query - City, country, timezone, or abbreviation
 * @returns {string} - The resolved IANA timezone or the original query if not found
 */
export function findTimezone(query) {
  const queryLower = query.toLowerCase().trim();

  // Check abbreviations first
  if (ABBREVIATIONS[queryLower]) {
    return ABBREVIATIONS[queryLower];
  }

  // Try to find by country name or code
  const country = ct.getCountry(query.toUpperCase()) ||
                  Object.values(ct.getAllCountries()).find(c =>
                    c.name.toLowerCase() === queryLower
                  );

  if (country && country.timezones && country.timezones.length > 0) {
    return country.timezones[0]; // Return primary timezone
  }

  // Try direct timezone lookup
  const timezone = ct.getTimezone(query);
  if (timezone) {
    return timezone.name;
  }

  // Try to find timezone by city name in the timezone identifier
  const allTimezones = ct.getAllTimezones();
  for (const [tzName, tz] of Object.entries(allTimezones)) {
    // Match city part of timezone (e.g., "New_York" from "America/New_York")
    const parts = tzName.split('/');
    const city = parts[parts.length - 1].replace(/_/g, ' ').toLowerCase();

    if (city === queryLower || tzName.toLowerCase() === queryLower) {
      return tzName;
    }
  }

  // Check if it's already a valid timezone (handles case like "America/New_York")
  if (isValidTimezone(query)) {
    return query;
  }

  // Fallback - return the query as-is
  return query;
}
