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

/**
 * @param {string} timezone - IANA timezone from config.toml
 * @returns {typeof moment} moment, defaulting to `timezone` for creation and formatting
 */
export function getVaultScriptMoment(timezone) {
  // Resolved on every call (not once at startup) so config hot-reload applies.
  // An unknown zone falls back to the process-local time rather than throwing.
  moment.tz.setDefault(timezone && moment.tz.zone(timezone) ? timezone : undefined);
  return moment;
}
