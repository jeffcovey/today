/**
 * update_event and delete_event: the MCP versions of `bin/calendar update`
 * and `bin/calendar delete`. Both write to an outside calendar, so they are
 * destructive: the caller must name the event's title, and dry_run is on
 * unless sent false.
 *
 * The write goes through the event plugin's write command the way
 * bin/calendar's callPluginWrite runs it: `{ action, event }` as JSON on
 * stdin, with the source's config (secrets decrypted) in PLUGIN_CONFIG.
 * Unlike bin/calendar, the event id sent is the calendar's own id: the
 * database id carries a "plugin/source:" prefix, which is stripped here.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  discoverPlugins,
  getPluginSources,
  injectDecryptedSettings,
  syncPluginSource,
} from '../plugin-loader.js';
import { getConfiguredTimezone } from '../date-utils.js';
import { staleNote } from '../mcp-reads.js';
import { verifyTitle, isDryRun, jsonResult, errorResult } from '../mcp-safeguards.js';
import { parseCallerTime, formatInZone, isValidTimeZone } from './_time.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WRITE_TIMEOUT_MS = 60 * 1000;
const EDITABLE_TEXT_FIELDS = ['new_title', 'location', 'description'];

/**
 * Find an event by its database id ("google-calendar/personal:abc123") or by
 * the calendar's own id ("abc123").
 * @returns {{row: object} | {error: string}}
 */
export function findEvent(db, eventId) {
  const id = String(eventId || '').trim();
  if (!id) return { error: 'event_id is required' };
  const exact = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (exact) return { row: exact };
  const byRemote = db.prepare("SELECT * FROM events WHERE substr(id, length(source) + 2) = ? AND substr(id, 1, length(source) + 1) = source || ':'").all(id);
  if (byRemote.length === 1) return { row: byRemote[0] };
  if (byRemote.length > 1) {
    return { error: `Several events have id ${id} (${byRemote.map(r => r.id).join(', ')}). Pass the full id from list_events.` };
  }
  return { error: `No event with id ${id}. Use list_events to find it (the calendar may need a sync).` };
}

/** The calendar's own id for a database row. */
export function remoteEventId(row) {
  const prefix = `${row.source}:`;
  return row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
}

/**
 * The enabled source an event came from, if its plugin can write.
 * @returns {Promise<{source: object} | {error: string}>}
 */
export async function writableEventSource(sourceId) {
  const [pluginName, sourceName] = String(sourceId || '').split('/');
  const plugins = await discoverPlugins();
  const plugin = plugins.get(pluginName);
  if (!plugin || plugin.type !== 'events') return { error: `The event's source ${sourceId} is not a calendar plugin` };
  if (!plugin.commands?.write) {
    return { error: `${sourceId} is a read-only calendar; its events can't be changed from here. Nothing was changed.` };
  }
  const configured = getPluginSources(pluginName).find(s => s.sourceName === sourceName);
  if (!configured) return { error: `The calendar source ${sourceId} is not enabled. Nothing was changed.` };
  return { source: { sourceId, plugin, sourceName, config: configured.config } };
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Run an event plugin's write command with `{ action, event }` on stdin.
 * @returns {Promise<object>} the plugin's JSON reply, or { success: false, error }
 */
export function runEventPluginWrite(source, action, event) {
  const { plugin, sourceName, config } = source;
  const defaults = {};
  for (const [key, def] of Object.entries(plugin.settings || {})) {
    if (def?.default !== undefined) defaults[key] = def.default;
  }
  const pluginConfig = injectDecryptedSettings(plugin, sourceName, { ...defaults, ...config });
  const script = path.join(plugin._path, plugin.commands.write);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: '1', PROJECT_ROOT, PLUGIN_CONFIG: JSON.stringify(pluginConfig) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), WRITE_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ success: false, error: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return resolve({ success: false, error: `The calendar write was stopped (${signal}) after ${WRITE_TIMEOUT_MS / 1000}s` });
      const lines = stripAnsi(stdout).split('\n').map(l => l.trim()).filter(l => l && !l.includes('[dotenvx'));
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return resolve(JSON.parse(lines[i]));
        } catch { /* not the JSON line */ }
      }
      const detail = stripAnsi(stderr).trim().split('\n').pop() || `exit code ${code}`;
      resolve({ success: false, error: `The calendar plugin gave no result: ${detail}` });
    });
    // A plugin that exits before reading all of stdin makes the pipe emit
    // EPIPE; unhandled, that would take down the server. The close handler
    // above still reports the plugin's result or its failure.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ action, event }));
  });
}

/** An event row as the caller sees it, with times in the user's zone. */
function describeEvent(row, tz) {
  const allDay = row.all_day === 1 || row.all_day === true;
  return {
    id: row.id,
    title: row.title,
    calendar: row.calendar_name || null,
    source: row.source,
    all_day: allDay,
    start: allDay ? row.start_date : formatInZone(row.start_date, tz),
    end: allDay ? row.end_date : formatInZone(row.end_date, tz),
    event_timezone: row.start_timezone || null,
    location: row.location || null,
    description: row.description || null,
  };
}

/**
 * Work out an update from the caller's fields.
 * @returns {{changes: object, payload: object} | {error: string}}
 */
export function buildEventUpdate(row, args, configuredTz) {
  const tz = args.timezone !== undefined && args.timezone !== null && args.timezone !== '' ? String(args.timezone) : configuredTz;
  if (!isValidTimeZone(tz)) return { error: `Unknown time zone "${args.timezone}"` };

  const changes = {};
  const payload = { id: remoteEventId(row) };

  for (const field of EDITABLE_TEXT_FIELDS) {
    if (args[field] === undefined || args[field] === null) continue;
    const value = String(args[field]).trim();
    if (!value) return { error: `${field} is empty; clearing a field isn't supported here. Nothing was changed.` };
    const column = field === 'new_title' ? 'title' : field;
    if (value === (row[column] || '')) continue;
    changes[column] = { from: row[column] || null, to: value };
    payload[column] = value;
  }

  const hasStart = args.start !== undefined && args.start !== null && args.start !== '';
  const hasEnd = args.end !== undefined && args.end !== null && args.end !== '';
  const hasZone = args.timezone !== undefined && args.timezone !== null && args.timezone !== '';
  if (hasStart || hasEnd || hasZone) {
    const allDay = row.all_day === 1 || row.all_day === true;
    if (allDay) return { error: 'This is an all-day event; changing its dates or time zone isn\'t supported here. Nothing was changed.' };

    const oldStart = new Date(row.start_date);
    const oldEnd = new Date(row.end_date);
    let start = oldStart;
    let end = oldEnd;
    if (hasStart) {
      const parsed = parseCallerTime(args.start, tz);
      if (parsed.error) return { error: `start: ${parsed.error}` };
      start = parsed.date;
    }
    if (hasEnd) {
      const parsed = parseCallerTime(args.end, tz);
      if (parsed.error) return { error: `end: ${parsed.error}` };
      end = parsed.date;
    } else if (hasStart) {
      // Moving the start alone keeps the event's length.
      end = new Date(start.getTime() + (oldEnd.getTime() - oldStart.getTime()));
    }
    if (end.getTime() <= start.getTime()) return { error: 'The event would end before it starts. Nothing was changed.' };

    const startIso = formatInZone(start, tz);
    const endIso = formatInZone(end, tz);
    // Reported in the user's zone; sent in the event's.
    const shown = d => formatInZone(d, configuredTz);
    if (start.getTime() !== oldStart.getTime()) changes.start = { from: shown(oldStart), to: shown(start) };
    if (end.getTime() !== oldEnd.getTime()) changes.end = { from: shown(oldEnd), to: shown(end) };
    const zoneChanged = tz !== (row.start_timezone || null);
    if (changes.start || changes.end || (hasZone && zoneChanged)) {
      // Both ends are sent, with the zone, so the event moves consistently;
      // the zone sent becomes the event's zone.
      if (zoneChanged) changes.timezone = { from: row.start_timezone || null, to: tz };
      payload.start_date = startIso;
      payload.end_date = endIso;
      payload.timezone = tz;
    }
  }

  if (Object.keys(changes).length === 0) {
    return { error: 'Nothing to change: pass new_title, start, end, location, description or timezone with a new value.' };
  }
  return { changes, payload };
}

function deps(ctx) {
  return {
    findSource: ctx.writableEventSource || writableEventSource,
    write: ctx.eventPluginWrite || runEventPluginWrite,
    sync: ctx.syncSource || syncPluginSource,
  };
}

async function loadVerifiedEvent(args, ctx, tz) {
  const sync = ctx.syncForRead ? await ctx.syncForRead(ctx.db, 'events') : null;
  const note = staleNote('calendar', sync);
  const found = findEvent(ctx.db, args.event_id);
  if (found.error) return { error: found.error };
  const check = verifyTitle(args.title, found.row.title, { what: 'event' });
  if (!check.ok) return { error: check.error };
  const source = await deps(ctx).findSource(found.row.source);
  if (source.error) return { error: source.error };
  return { row: found.row, source: source.source, note, event: describeEvent(found.row, tz) };
}

async function refreshCalendar(ctx, source) {
  try {
    const result = await deps(ctx).sync(source.plugin, source.sourceName, source.config, { db: ctx.db }, {
      skipAutoTag: true,
      _caller: 'mcp-write',
    });
    if (result && result.success === false) return `The calendar changed, but the local copy did not refresh: ${result.message || result.error}`;
  } catch (error) {
    return `The calendar changed, but the local copy did not refresh: ${error.message}`;
  }
  return null;
}

async function updateEvent(args, ctx) {
  const tz = getConfiguredTimezone();
  const loaded = await loadVerifiedEvent(args, ctx, tz);
  if (loaded.error) return errorResult(loaded.error);
  const { row, source, note, event } = loaded;

  const built = buildEventUpdate(row, args, tz);
  if (built.error) return errorResult(built.error);
  const { changes, payload } = built;
  const reminderNote = 'The calendar plugin resets this event\'s reminders to the calendar\'s default when it updates an event.';

  if (isDryRun(args)) {
    return jsonResult({
      dry_run: true,
      event,
      changes,
      note: reminderNote,
      user_timezone: tz,
    }, [note, `Dry run: nothing was changed. Would update "${row.title}" in ${source.sourceId}: ${Object.keys(changes).join(', ')}. ` +
      'Call again with dry_run: false to apply.'].filter(Boolean).join('\n'));
  }

  const result = await deps(ctx).write(source, 'update', payload);
  if (!result?.success) return errorResult(`The calendar refused the update: ${result?.error || 'unknown error'}. Nothing was changed.`);
  const syncNote = await refreshCalendar(ctx, source);

  return jsonResult({
    dry_run: false,
    updated: event.id,
    changes,
    link: result.html_link || null,
    note: [reminderNote, syncNote].filter(Boolean).join(' '),
    user_timezone: tz,
  }, `Updated "${changes.title ? changes.title.to : row.title}" in ${source.sourceId}: ${Object.keys(changes).join(', ')}.`);
}

async function deleteEvent(args, ctx) {
  const tz = getConfiguredTimezone();
  const loaded = await loadVerifiedEvent(args, ctx, tz);
  if (loaded.error) return errorResult(loaded.error);
  const { row, source, note, event } = loaded;

  if (isDryRun(args)) {
    return jsonResult({ dry_run: true, would_delete: event, user_timezone: tz },
      [note, `Dry run: nothing was deleted. Would delete "${row.title}" (${event.start}) from ${source.sourceId}. ` +
        'Call again with dry_run: false to delete it.'].filter(Boolean).join('\n'));
  }

  const result = await deps(ctx).write(source, 'delete', { id: remoteEventId(row) });
  if (!result?.success) return errorResult(`The calendar refused the delete: ${result?.error || 'unknown error'}. Nothing was deleted.`);
  const syncNote = await refreshCalendar(ctx, source);

  return jsonResult({
    dry_run: false,
    deleted: event,
    ...(syncNote ? { note: syncNote } : {}),
    user_timezone: tz,
  }, `Deleted "${row.title}" (${event.start}) from ${source.sourceId}.`);
}

const COMMON = {
  event_id: { type: 'string', description: 'The event\'s id from list_events' },
  title: { type: 'string', description: 'The event\'s current title (or a distinctive part of it), to confirm which event this is' },
  dry_run: { type: 'boolean', description: 'Default true: report what would change and change nothing. Send false to apply.' },
};

export const tools = [
  {
    name: 'update_event',
    kind: 'destructive',
    pluginType: 'events',
    description: 'Change an event in a writable calendar such as Google Calendar (like `bin/calendar update`). ' +
      'Requires the event\'s current title. dry_run is on by default: it returns the event as it is and the exact change; ' +
      'send dry_run: false to apply. Naive times (2026-11-01T09:00) are read in the user\'s time zone, or in timezone when given. ' +
      'Moving the start alone keeps the event\'s length. Events from read-only calendars are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        ...COMMON,
        new_title: { type: 'string', description: 'New title' },
        start: { type: 'string', description: 'New start: ISO with offset, or local time read in the user\'s (or the given) time zone' },
        end: { type: 'string', description: 'New end, same forms as start' },
        location: { type: 'string', description: 'New location' },
        description: { type: 'string', description: 'New description' },
        timezone: { type: 'string', description: 'IANA time zone for naive start/end and for the event (e.g. America/New_York)' },
      },
      required: ['event_id', 'title'],
    },
    handler: updateEvent,
  },
  {
    name: 'delete_event',
    kind: 'destructive',
    pluginType: 'events',
    description: 'Delete an event from a writable calendar such as Google Calendar (like `bin/calendar delete`). ' +
      'Requires the event\'s current title. dry_run is on by default and shows the event that would be deleted; ' +
      'send dry_run: false to delete it. Events from read-only calendars are refused.',
    inputSchema: {
      type: 'object',
      properties: { ...COMMON },
      required: ['event_id', 'title'],
    },
    handler: deleteEvent,
  },
];
