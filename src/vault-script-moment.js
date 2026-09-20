/**
 * The `moment` handed to vault scripts (dv.view() scripts and dataviewjs
 * blocks) when they are rendered by the web server.
 *
 * In Obsidian these scripts get a moment that works in the device's local
 * time. The web server's process timezone is whatever the host uses
 * (typically UTC), so plain moment would format times like
 * `moment(entry.start).format('h:mm A')` in UTC. Default the zone to the
 * user's configured timezone instead.
 */

import moment from 'moment-timezone';

const FORMAT_WITH_TIMEZONE_RE = /Z{1,2}|z{1,2}/;
const TIMEZONE_IN_INPUT_RE = /[T\s]\d{2}(?::?\d{2}){0,2}(?:\.\d+)?\s*(?:Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)$/i;

function shouldPreserveParsedInstant(args) {
  const [input, format] = args;

  if (moment.isMoment(input) || input instanceof Date || typeof input === 'number') {
    return true;
  }

  if (typeof input !== 'string') return false;
  if (TIMEZONE_IN_INPUT_RE.test(input)) return true;

  if (typeof format === 'string') return FORMAT_WITH_TIMEZONE_RE.test(format);
  if (Array.isArray(format)) return format.some(candidate => typeof candidate === 'string' && FORMAT_WITH_TIMEZONE_RE.test(candidate));

  return false;
}

/**
 * @param {string} timezone - IANA timezone from config.toml
 * @returns {typeof moment} moment-like facade, defaulting to `timezone` for direct calls
 */
export function getVaultScriptMoment(timezone) {
  // Resolved on every call (not once at startup) so config hot-reload applies.
  // An unknown zone falls back to the process-local time rather than throwing.
  const zone = timezone && moment.tz.zone(timezone) ? timezone : undefined;

  const vaultMoment = (...args) => {
    if (!zone) return moment(...args);
    if (args.length === 0) return moment.tz(zone);
    if (shouldPreserveParsedInstant(args)) return moment(...args).tz(zone);
    return moment.tz(...args, zone);
  };

  vaultMoment.duration = moment.duration;
  vaultMoment.unix = moment.unix;
  vaultMoment.utc = moment.utc;
  vaultMoment.isMoment = moment.isMoment;
  vaultMoment.locale = moment.locale;
  vaultMoment.tz = moment.tz;

  return vaultMoment;
}
