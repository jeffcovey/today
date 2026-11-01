/**
 * Contact reads (issue #686): upcoming_birthdays and search_contacts, from
 * the `contacts` table the contacts plugins sync (what `bin/contacts
 * birthday` and `bin/contacts search` read).
 */

import { jsonResult, errorResult } from '../mcp-safeguards.js';
import {
  getConfiguredTimezone, clampInt, todayIn, isDay, addDays, cap, parseJson,
  likeTerm, isMissingTable, freshen, lead,
} from './_medium-reads-helpers.js';

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;
export const BIRTHDAYS_DEFAULT_LIMIT = 50;
export const BIRTHDAYS_MAX_LIMIT = 200;
const NOTES_CHARS = 500;

/**
 * A stored birthday as { year, monthDay }. Contacts sync BDAY as written:
 * YYYY-MM-DD, YYYYMMDD (the iCloud writer's form), or --MM-DD / --MMDD with
 * no year.
 */
function parseBirthday(birthday) {
  const m = /^(\d{4}|--)-?(\d{2})-?(\d{2})/.exec(String(birthday || '').trim());
  if (!m) return null;
  const year = m[1] === '--' ? null : Number(m[1]);
  // Apple Contacts stores "no year" as 1604; anything that old is not a year.
  return { year: year && year > 1900 ? year : null, monthDay: `${m[2]}-${m[3]}` };
}

export async function upcomingBirthdays(args, ctx) {
  const tz = getConfiguredTimezone();
  const now = ctx.now ?? new Date();
  if (args.date !== undefined && !isDay(args.date)) return errorResult('date must be YYYY-MM-DD');
  const start = args.date || todayIn(tz, now);
  // With a date and no days, show that one day (like bin/contacts birthday --date).
  const days = clampInt(args.days, args.date ? 1 : 7, 1, 366);
  const limit = clampInt(args.limit, BIRTHDAYS_DEFAULT_LIMIT, 1, BIRTHDAYS_MAX_LIMIT);
  const note = await freshen(ctx, 'contacts', 'contacts');

  let contacts;
  try {
    contacts = ctx.db.prepare(`
      SELECT full_name, nickname, birthday, organization, primary_email, primary_phone
      FROM contacts
      WHERE birthday IS NOT NULL AND birthday != ''
      ORDER BY full_name
    `).all();
  } catch (error) {
    if (isMissingTable(error)) return jsonResult({ user_timezone: tz, start, days, total: 0, birthdays: [] }, 'No contacts have been synced yet.');
    throw error;
  }
  const byMonthDay = new Map();
  for (const c of contacts) {
    const parsed = parseBirthday(c.birthday);
    if (!parsed) continue;
    if (!byMonthDay.has(parsed.monthDay)) byMonthDay.set(parsed.monthDay, []);
    byMonthDay.get(parsed.monthDay).push({ ...c, year: parsed.year });
  }

  const birthdays = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    for (const c of byMonthDay.get(day.slice(5)) || []) {
      const year = c.year;
      birthdays.push({
        date: day,
        days_away: i,
        name: c.full_name,
        nickname: c.nickname || null,
        birthday: c.birthday,
        turning: year ? Number(day.slice(0, 4)) - year : null,
        organization: c.organization || null,
        primary_email: c.primary_email || null,
        primary_phone: c.primary_phone || null,
      });
    }
  }

  const end = addDays(start, days - 1);
  const span = days === 1 ? `on ${start}` : `from ${start} through ${end}`;
  const total = birthdays.length;
  const shown = birthdays.slice(0, limit);
  const text = total === 0
    ? `No birthdays ${span}.`
    : `${total} birthday(s) ${span}${shown.length < total ? `; showing the first ${shown.length} (raise limit or narrow days for more)` : ''}.`;
  return jsonResult({
    user_timezone: tz, start, end, days, total, returned: shown.length, limit, has_more: shown.length < total, birthdays: shown,
  }, lead(text, note));
}

function contactRecord(c) {
  const meta = parseJson(c.metadata, {});
  const notes = cap(c.notes, NOTES_CHARS);
  const emails = Array.isArray(meta.emails) ? meta.emails.map(e => (typeof e === 'string' ? e : e?.value)).filter(Boolean) : [];
  const phones = Array.isArray(meta.phones) ? meta.phones.map(p => (typeof p === 'string' ? p : p?.value)).filter(Boolean) : [];
  return {
    id: c.id,
    name: c.full_name,
    nickname: c.nickname || null,
    organization: c.organization || null,
    job_title: c.job_title || null,
    primary_email: c.primary_email || null,
    primary_phone: c.primary_phone || null,
    other_emails: emails.filter(e => e !== c.primary_email),
    other_phones: phones.filter(p => p !== c.primary_phone),
    birthday: c.birthday || null,
    location: [c.location_city, c.location_state, c.location_country].filter(Boolean).join(', ') || null,
    notes: notes.text,
    notes_truncated: notes.truncated,
    source: c.source,
  };
}

export async function searchContacts(args, ctx) {
  const query = String(args.query ?? '').trim();
  if (!query) return errorResult('query is required');
  const limit = clampInt(args.limit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
  const note = await freshen(ctx, 'contacts', 'contacts');

  const term = likeTerm(query.toLowerCase());
  // Secondary addresses live in metadata.emails (iCloud); CASE guards
  // json_extract against a malformed metadata value.
  const cols = ['full_name', 'nickname', 'organization', 'notes', 'primary_email',
    "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.emails') END"];
  const where = cols.map(col => `LOWER(${col}) LIKE ? ESCAPE '\\'`).join(' OR ');
  const params = Array(cols.length).fill(term);
  let total;
  let rows;
  try {
    total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE ${where}`).get(...params).n;
    rows = ctx.db.prepare(`
      SELECT id, source, full_name, nickname, organization, job_title, primary_email, primary_phone,
             birthday, notes, metadata, location_city, location_state, location_country
      FROM contacts WHERE ${where}
      ORDER BY full_name, id
      LIMIT ?
    `).all(...params, limit);
  } catch (error) {
    if (isMissingTable(error)) return jsonResult({ query, total: 0, contacts: [] }, 'No contacts have been synced yet.');
    throw error;
  }

  const contacts = rows.map(contactRecord);
  const text = total === 0
    ? `No contact matches "${query}" by name, nickname, organization, email or notes.`
    : `${total} contact(s) match "${query}"${contacts.length < total ? `; showing the first ${contacts.length}` : ''}.`;
  return jsonResult({ query, total, returned: contacts.length, limit, has_more: contacts.length < total, contacts }, lead(text, note));
}

export const tools = [
  {
    name: 'upcoming_birthdays',
    kind: 'read',
    pluginType: 'contacts',
    description: 'Birthdays in the user\'s contacts over the next few days (like bin/contacts birthday), with the age they turn when the birth year is known.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days to look ahead, today included (default 7, max 366; 1 when date is given).' },
        date: { type: 'string', description: 'Start from this day (YYYY-MM-DD) instead of today.' },
        limit: { type: 'number', description: `Max birthdays (default ${BIRTHDAYS_DEFAULT_LIMIT}, max ${BIRTHDAYS_MAX_LIMIT}).` },
      },
    },
    handler: upcomingBirthdays,
  },
  {
    name: 'search_contacts',
    kind: 'read',
    pluginType: 'contacts',
    description: 'Find contacts by name, nickname, organization, email or notes (like bin/contacts search): name, organization, primary email and phone, other emails and phones, birthday, location and notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for.' },
        limit: { type: 'number', description: `Max contacts (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` },
      },
      required: ['query'],
    },
    handler: searchContacts,
  },
];
