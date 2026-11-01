/**
 * add_diary_entry: the MCP version of `bin/diary add`.
 *
 * The markdown-diary plugin has no write command, so the entry goes straight
 * into the day's diary file through src/diary-add.js, then that source is
 * synced so diary reads see it.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { getSourcesForType, syncPluginSource } from '../plugin-loader.js';
import { getConfiguredTimezone } from '../date-utils.js';
import { jsonResult, errorResult } from '../mcp-safeguards.js';
import { addDiaryEntry, resolveDiaryDirectory, DiaryBusyError, DIARY_ADD_TYPES } from '../diary-add.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_TEXT = 10000;
const WRITABLE_PLUGIN = 'markdown-diary';

/** The markdown-diary source to write to, or an error. */
export async function pickDiarySource(sourceFilter) {
  const { sources } = await getSourcesForType('diary', sourceFilter || null);
  const writable = sources.filter(s => s.plugin.name === WRITABLE_PLUGIN);
  if (writable.length === 0) {
    return { error: sourceFilter
      ? `No ${WRITABLE_PLUGIN} source matches "${sourceFilter}". Only markdown diary sources take new entries.`
      : `No ${WRITABLE_PLUGIN} source is enabled. Only markdown diary sources take new entries.` };
  }
  if (writable.length > 1) {
    return { error: `Several diary sources could take this entry (${writable.map(s => s.sourceId).join(', ')}). Pass source to pick one.` };
  }
  return { source: writable[0] };
}

async function addDiaryEntryHandler(args, ctx) {
  const type = String(args.type || '').toLowerCase().trim();
  if (!DIARY_ADD_TYPES.includes(type)) {
    return errorResult(`type must be one of ${DIARY_ADD_TYPES.join(', ')}. Role entries are written by the roles themselves.`);
  }
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return errorResult('text is required');
  if (text.length > MAX_TEXT) return errorResult(`text is ${text.length} characters; the limit is ${MAX_TEXT}`);
  if (/<!--\s*(ROLE|TODAY):/i.test(text)) return errorResult('text may not contain ROLE: or TODAY: marker comments');
  if (type === 'gratitude' && /[\r\n]/.test(text)) {
    return errorResult('A gratitude entry is one bullet line; send it without line breaks');
  }
  if (/^#{1,2}\s/m.test(text)) {
    return errorResult('text may not contain "#" or "##" headings, which would start a new diary section');
  }

  const picked = await (ctx.pickDiarySource || pickDiarySource)(args.source);
  if (picked.error) return errorResult(picked.error);
  const { source } = picked;

  const tz = getConfiguredTimezone();
  const now = ctx.now ? ctx.now() : new Date();
  let written;
  try {
    written = addDiaryEntry({
      type,
      text,
      diaryDir: resolveDiaryDirectory(source.config),
      timezone: tz,
      now,
    });
  } catch (error) {
    if (error instanceof DiaryBusyError) return errorResult(error.message);
    throw error;
  }

  let syncNote = null;
  if (ctx.db) {
    try {
      const sync = ctx.syncSource || syncPluginSource;
      const result = await sync(source.plugin, source.sourceName, source.config, { db: ctx.db }, {
        fileFilter: path.relative(PROJECT_ROOT, written.file),
        skipAutoTag: true,
        _caller: 'mcp-write',
      });
      if (result && result.success === false) syncNote = `Saved, but the diary cache did not refresh: ${result.message || result.error}`;
    } catch (error) {
      syncNote = `Saved, but the diary cache did not refresh: ${error.message}`;
    }
  }

  const lead = `Added a ${type} entry to the diary for ${written.date}${type === 'gratitude' ? '' : ` at ${written.time}`}.`;
  return jsonResult({
    type,
    date: written.date,
    time: type === 'gratitude' ? null : written.time,
    markdown: written.markdown,
    file: path.relative(PROJECT_ROOT, written.file),
    source: source.sourceId,
    created_file: written.created,
    user_timezone: tz,
    ...(syncNote ? { note: syncNote } : {}),
  }, lead);
}

export const tools = [
  {
    name: 'add_diary_entry',
    kind: 'write',
    pluginType: 'diary',
    description: 'Add an entry to today\'s diary (like `bin/diary add`). Types: gratitude (one bullet under "I\'m grateful for..."), ' +
      'progress, concern and journal (each a timestamped "### HH:MM" block). Role entries are written by the roles, not here. ' +
      'Returns the markdown written and the file.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: DIARY_ADD_TYPES, description: 'Entry type' },
        text: { type: 'string', description: 'The entry text. Gratitude is one line, written as what follows "I\'m grateful for".' },
        source: { type: 'string', description: 'Diary source to write to, if more than one markdown diary is enabled' },
      },
      required: ['type', 'text'],
    },
    handler: addDiaryEntryHandler,
  },
];
