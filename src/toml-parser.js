/**
 * TOML parser wrapper using smol-toml library.
 */

import { parse } from 'smol-toml';

export { parse as parseTOML };

/**
 * Get a nested value using dot notation.
 * @param {object} config - The configuration object
 * @param {string} keyPath - Dot-notation path (e.g., "profile.name")
 * @returns {*} - The value at the path, or undefined if not found
 */
export function getNestedValue(config, keyPath) {
  const keys = keyPath.split('.');
  let value = config;

  for (const key of keys) {
    if (typeof value === 'object' && value !== null && key in value) {
      value = value[key];
    } else {
      return undefined;
    }
  }

  return value;
}
