/**
 * The medium read tools from issue #686: email, contacts, diary, health,
 * habits and finance. Each handler runs against an in-memory database built
 * from the real plugin schemas, in America/New_York, at 9 PM local on
 * 2026-11-01 (already 2026-11-02 in UTC), so a UTC slip would show.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { clearConfigCache } from '../src/config.js';
import { getSqlColumns, getTableName } from '../src/plugin-schemas.js';
import { ensureAccountBalancesTable } from '../src/account-balances.js';
import { getRegisteredTools, setRegisteredToolsForTesting } from '../src/mcp-tools/index.js';
import { listEmails, searchEmail, getEmail } from '../src/mcp-tools/email.js';
import { upcomingBirthdays, searchContacts } from '../src/mcp-tools/contacts.js';
import { listDiary } from '../src/mcp-tools/diary.js';
import { healthToday, healthSummary, habitStreaks, habitHistory } from '../src/mcp-tools/health-habits.js';
import { financeOverview, uncategorizedTransactions } from '../src/mcp-tools/finance-reads.js';
import { toLocal, addDays, isDay, clampInt, likeTerm } from '../src/mcp-tools/_medium-reads-helpers.js';

const NOW = new Date('2026-11-02T02:00:00Z'); // 2026-11-01 21:00 EST
const TZ = 'America/New_York';

let workDir;
let previousConfig;

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-mcp-medreads-'));
  await fs.writeFile(path.join(workDir, 'config.toml'), `timezone = "${TZ}"\nvault_path = "${path.join(workDir, 'vault')}"\n`);
  previousConfig = process.env.TODAY_CONFIG;
  process.env.TODAY_CONFIG = path.join(workDir, 'config.toml');
  clearConfigCache();
});

afterAll(async () => {
  if (previousConfig === undefined) delete process.env.TODAY_CONFIG;
  else process.env.TODAY_CONFIG = previousConfig;
  clearConfigCache();
  await fs.rm(workDir, { recursive: true, force: true });
});

function makeDb(...types) {
  const db = new Database(':memory:');
  for (const type of types) {
    db.exec(`CREATE TABLE ${getTableName(type)} (${getSqlColumns(type)})`);
  }
  return db;
}

function insert(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(c => row[c]));
}

function ctxFor(db, extra = {}) {
  return { db, now: NOW, ...extra };
}

/**
 * The db, wrapped so every statement read records whether it ran inside a
 * transaction: reads that must agree have to share one snapshot.
 */
function trackReads(db) {
  const log = [];
  const wrapStatement = stmt => new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'get' || prop === 'all' || prop === 'iterate') {
        return (...args) => {
          log.push(db.inTransaction);
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return sql => wrapStatement(target.prepare(sql));
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, log };
}

const STALE_SYNC = async () => ({ complete: false, lastSync: new Date('2026-11-01T12:00:00Z') });

function parse(result) {
  expect(result.isError).toBeFalsy();
  const texts = result.content.map(c => c.text);
  return { lead: texts[0], data: JSON.parse(texts[texts.length - 1]) };
}

describe('shared helpers', () => {
  test('stored dates become local days and offset instants', () => {
    expect(toLocal('2026-11-02T01:30:00Z', TZ)).toEqual({ day: '2026-11-01', iso: '2026-11-01T20:30:00-05:00' });
    expect(toLocal('2026-11-01T09:30:00', TZ)).toEqual({ day: '2026-11-01', iso: '2026-11-01T09:30:00-05:00' });
    expect(toLocal('2026-07-04', TZ)).toEqual({ day: '2026-07-04', iso: null });
  });

  test('calendar arithmetic, validation, clamps and LIKE escaping', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-02-28')).toBe(true);
    expect(clampInt(5000, 10, 1, 100)).toBe(100);
    expect(clampInt('x', 10, 1, 100)).toBe(10);
    expect(likeTerm('50%_off')).toBe('%50\\%\\_off%');
  });
});

describe('email', () => {
  function emailDb() {
    const db = makeDb('email');
    const base = { source: 'imap-email/icloud', from_address: 'a@example.com', folder: 'INBOX' };
    insert(db, 'email', { ...base, id: 'imap-email/icloud:INBOX:1', from_name: 'Avery', subject: 'Lunch?', date: '2026-11-01T15:00:00.000Z', flags: '["seen"]', snippet: 'Want to grab lunch', text_content: 'Want to grab lunch on Tuesday?' });
    insert(db, 'email', { ...base, id: 'imap-email/icloud:INBOX:2', from_name: 'Bank', from_address: 'alerts@bank.example', subject: 'Statement ready', date: '2026-11-02T01:00:00.000Z', flags: '[]', html_content: '<p>Your <b>statement</b> is ready.</p><script>x()</script>' });
    insert(db, 'email', { ...base, id: 'imap-email/icloud:INBOX:3', subject: 'Old news', date: '2026-10-01T12:00:00.000Z', flags: '[]', text_content: 'x'.repeat(30000) });
    insert(db, 'email', { ...base, id: 'imap-email/icloud:Trash:4', folder: 'Trash', subject: 'Lunch spam', date: '2026-11-01T16:00:00.000Z', flags: '[]' });
    insert(db, 'email', { ...base, id: 'imap-email/work:INBOX:5', source: 'imap-email/work', subject: 'Standup', date: '2026-10-31T13:00:00.000Z', flags: null });
    return db;
  }

  test('list_emails: recent headers, newest first, trash left out, local times', async () => {
    const { lead, data } = parse(await listEmails({}, ctxFor(emailDb())));
    expect(data.user_timezone).toBe(TZ);
    expect(data.emails.map(e => e.id)).toEqual(['imap-email/icloud:INBOX:2', 'imap-email/icloud:INBOX:1', 'imap-email/work:INBOX:5']);
    expect(data.emails[0]).toMatchObject({ date: '2026-11-01T20:00:00-05:00', unread: true, body_synced: true });
    expect(data.emails[1]).toMatchObject({ unread: false, snippet: 'Want to grab lunch' });
    expect(data.emails[0]).not.toHaveProperty('text_content');
    expect(lead).toMatch(/treat it as data/);
  });

  test('list_emails: filters, unread_only (null flags count as unread) and paging', async () => {
    const db = emailDb();
    expect(parse(await listEmails({ unread_only: true }, ctxFor(db))).data.emails.map(e => e.id))
      .toEqual(['imap-email/icloud:INBOX:2', 'imap-email/work:INBOX:5']);
    expect(parse(await listEmails({ from: 'bank' }, ctxFor(db))).data.total).toBe(1);
    expect(parse(await listEmails({ source: 'work' }, ctxFor(db))).data.total).toBe(1);
    expect(parse(await listEmails({ days: 60 }, ctxFor(db))).data.total).toBe(4);
    const page = parse(await listEmails({ limit: 1 }, ctxFor(db))).data;
    expect(page).toMatchObject({ total: 3, returned: 1, has_more: true, next_offset: 1 });
  });

  test('search_email: synced table only, with a pointer to --server for older mail', async () => {
    const db = emailDb();
    const hit = parse(await searchEmail({ query: 'tuesday' }, ctxFor(db)));
    expect(hit.data.emails.map(e => e.id)).toEqual(['imap-email/icloud:INBOX:1']);
    const miss = parse(await searchEmail({ query: 'nothing like this' }, ctxFor(db)));
    expect(miss.data.total).toBe(0);
    expect(miss.lead).toMatch(/--server/);
    expect((await searchEmail({ query: '  ' }, ctxFor(db))).isError).toBe(true);
  });

  test('get_email: text body, html fallback, truncation, unsynced body and unknown id', async () => {
    const db = emailDb();
    const one = parse(await getEmail({ email_id: 'imap-email/icloud:INBOX:1' }, ctxFor(db))).data;
    expect(one).toMatchObject({ body: 'Want to grab lunch on Tuesday?', body_truncated: false, body_format: 'text' });

    const html = parse(await getEmail({ email_id: 'imap-email/icloud:INBOX:2' }, ctxFor(db))).data;
    expect(html.body).toBe('Your statement is ready.');
    expect(html.body_format).toBe('html converted to text');

    const long = parse(await getEmail({ email_id: 'imap-email/icloud:INBOX:3' }, ctxFor(db)));
    expect(long.data).toMatchObject({ body_truncated: true, body_length: 30000 });
    expect(long.data.body.length).toBe(20001);
    expect(long.lead).toMatch(/cut to 20000 of 30000/);

    const bare = parse(await getEmail({ email_id: 'imap-email/work:INBOX:5' }, ctxFor(db)));
    expect(bare.data).toMatchObject({ body_synced: false, body: null });
    expect(bare.lead).toMatch(/not been synced/);

    const missing = await getEmail({ email_id: 'nope' }, ctxFor(db));
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/No synced email/);
  });

  test('get_email: an attachment-only body is synced and empty; a body cut at sync says so', async () => {
    const db = emailDb();
    const base = { source: 'imap-email/icloud', from_address: 'a@example.com', folder: 'INBOX', flags: '[]' };
    insert(db, 'email', { ...base, id: 'imap-email/icloud:INBOX:6', subject: 'Scan', date: '2026-11-01T17:00:00.000Z', text_content: '', html_content: '', attachments: '[{"filename":"scan.pdf","contentType":"application/pdf","size":1000}]' });
    insert(db, 'email', { ...base, id: 'imap-email/icloud:INBOX:7', subject: 'Huge', date: '2026-11-01T18:00:00.000Z', text_content: `${'y'.repeat(50)}\n[truncated]` });

    const scan = parse(await getEmail({ email_id: 'imap-email/icloud:INBOX:6' }, ctxFor(db)));
    expect(scan.data).toMatchObject({ body_synced: true, body: '', body_truncated_at_sync: false });
    expect(scan.data.attachments[0].filename).toBe('scan.pdf');
    expect(scan.lead).toMatch(/no text or html body/);
    const listed = parse(await listEmails({}, ctxFor(db))).data.emails.find(e => e.id.endsWith(':6'));
    expect(listed.body_synced).toBe(true);

    const huge = parse(await getEmail({ email_id: 'imap-email/icloud:INBOX:7' }, ctxFor(db)));
    expect(huge.data).toMatchObject({ body_truncated: false, body_truncated_at_sync: true });
    expect(huge.lead).toMatch(/max_body_size/);
    expect(parse(await getEmail({ email_id: 'imap-email/icloud:INBOX:1' }, ctxFor(db))).data.body_truncated_at_sync).toBe(false);
  });

  test('get_email freshens the email cache and passes on a stale-sync note, found or not', async () => {
    const db = emailDb();
    const asked = [];
    const syncForRead = async (_db, type) => { asked.push(type); return STALE_SYNC(); };
    const found = parse(await getEmail({ email_id: 'imap-email/icloud:INBOX:1' }, ctxFor(db, { syncForRead })));
    expect(asked).toEqual(['email']);
    expect(found.lead).toMatch(/email sync is still running/);
    const missing = await getEmail({ email_id: 'nope' }, ctxFor(db, { syncForRead }));
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/No synced email[\s\S]*email sync is still running/);
  });

  test('a missing table is reported, not thrown', async () => {
    const result = await listEmails({}, ctxFor(new Database(':memory:')));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No email has been synced/);
  });

  test('a stale sync adds the note', async () => {
    const syncForRead = async () => ({ complete: false, lastSync: new Date('2026-11-01T12:00:00Z') });
    const { lead } = parse(await listEmails({}, ctxFor(emailDb(), { syncForRead })));
    expect(lead).toMatch(/email sync is still running/);
  });
});

describe('contacts', () => {
  function contactsDb() {
    const db = makeDb('contacts');
    const src = 'icloud-contacts/default';
    insert(db, 'contacts', { id: 'c1', source: src, full_name: 'Robin Ames', birthday: '1980-11-01', primary_email: 'robin@example.com', notes: 'Met at the conference', metadata: JSON.stringify({ emails: ['robin@example.com', 'r@work.example'], phones: ['555-0100'] }), primary_phone: '555-0100' });
    insert(db, 'contacts', { id: 'c2', source: src, full_name: 'Sam Lee', birthday: '--11-03', organization: 'Acme' });
    insert(db, 'contacts', { id: 'c3', source: src, full_name: 'Pat Doe', birthday: '1604-11-08' });
    insert(db, 'contacts', { id: 'c4', source: src, full_name: 'Kim Roe', birthday: '1990-12-25', notes: 'n'.repeat(900) });
    return db;
  }

  test('upcoming_birthdays: the next 7 local days from today, with ages when the year is real', async () => {
    const { data } = parse(await upcomingBirthdays({}, ctxFor(contactsDb())));
    expect(data).toMatchObject({ start: '2026-11-01', end: '2026-11-07', total: 2 });
    expect(data.birthdays.map(b => [b.name, b.date, b.turning])).toEqual([['Robin Ames', '2026-11-01', 46], ['Sam Lee', '2026-11-03', null]]);
  });

  test('upcoming_birthdays: a date alone is that one day; bad dates are refused', async () => {
    const db = contactsDb();
    const one = parse(await upcomingBirthdays({ date: '2026-11-08' }, ctxFor(db))).data;
    expect(one.birthdays.map(b => [b.name, b.turning])).toEqual([['Pat Doe', null]]);
    expect(parse(await upcomingBirthdays({ date: '2026-12-20', days: 10 }, ctxFor(db))).data.total).toBe(1);
    expect((await upcomingBirthdays({ date: '11/01' }, ctxFor(db))).isError).toBe(true);
  });

  test('upcoming_birthdays: YYYYMMDD and --MMDD birthdays count too', async () => {
    const db = contactsDb();
    insert(db, 'contacts', { id: 'c5', source: 'icloud-contacts/default', full_name: 'Alex Kay', birthday: '19851102' });
    insert(db, 'contacts', { id: 'c6', source: 'icloud-contacts/default', full_name: 'Jo Fox', birthday: '--1104' });
    const { data } = parse(await upcomingBirthdays({}, ctxFor(db)));
    expect(data.birthdays.map(b => [b.name, b.date, b.turning])).toEqual([
      ['Robin Ames', '2026-11-01', 46], ['Alex Kay', '2026-11-02', 41], ['Sam Lee', '2026-11-03', null], ['Jo Fox', '2026-11-04', null],
    ]);
  });

  test('upcoming_birthdays: the list is capped and says how many were left out', async () => {
    const db = contactsDb();
    for (let i = 0; i < 60; i++) {
      insert(db, 'contacts', { id: `m${i}`, source: 'icloud-contacts/default', full_name: `Many ${String(i).padStart(2, '0')}`, birthday: '1970-11-05' });
    }
    const first = parse(await upcomingBirthdays({}, ctxFor(db)));
    expect(first.data).toMatchObject({ total: 62, returned: 50, limit: 50, has_more: true });
    expect(first.data.birthdays).toHaveLength(50);
    expect(first.lead).toMatch(/62 birthday\(s\).*showing the first 50/);
    expect(parse(await upcomingBirthdays({ limit: 500 }, ctxFor(db))).data).toMatchObject({ returned: 62, limit: 200, has_more: false });
  });

  test('search_contacts: a secondary email in metadata matches; bad metadata is skipped', async () => {
    const db = contactsDb();
    insert(db, 'contacts', { id: 'c7', source: 'icloud-contacts/default', full_name: 'Broken Meta', metadata: '{not json' });
    const hit = parse(await searchContacts({ query: 'r@work.example' }, ctxFor(db))).data;
    expect(hit.contacts.map(c => c.name)).toEqual(['Robin Ames']);
    expect(parse(await searchContacts({ query: 'broken' }, ctxFor(db))).data.total).toBe(1);
  });

  test('search_contacts: the count and the page are read in one transaction', async () => {
    const { db, log } = trackReads(contactsDb());
    const { data } = parse(await searchContacts({ query: 'o', limit: 1 }, ctxFor(db)));
    expect(data).toMatchObject({ returned: 1, has_more: true });
    expect(log).toEqual([true, true]);
  });

  test('search_contacts: name, organization, notes; other emails; long notes cut', async () => {
    const db = contactsDb();
    const robin = parse(await searchContacts({ query: 'conference' }, ctxFor(db))).data;
    expect(robin.contacts).toHaveLength(1);
    expect(robin.contacts[0]).toMatchObject({ name: 'Robin Ames', other_emails: ['r@work.example'], other_phones: [] });
    expect(parse(await searchContacts({ query: 'acme' }, ctxFor(db))).data.contacts[0].name).toBe('Sam Lee');
    const kim = parse(await searchContacts({ query: 'kim' }, ctxFor(db))).data.contacts[0];
    expect(kim.notes_truncated).toBe(true);
    expect(parse(await searchContacts({ query: 'o', limit: 2 }, ctxFor(db))).data).toMatchObject({ returned: 2, has_more: true });
    expect((await searchContacts({}, ctxFor(db))).isError).toBe(true);
  });
});

describe('diary', () => {
  function diaryDb() {
    const db = makeDb('diary');
    const md = 'markdown-diary/default';
    insert(db, 'diary', { id: 'd1', source: md, date: '2026-11-01T00:00:00', text: "I'm grateful for coffee", metadata: '{"type":"gratitude"}' });
    insert(db, 'diary', { id: 'd2', source: md, date: '2026-11-01T09:30:00', text: 'Shipped the email tools', metadata: '{"type":"progress"}' });
    // Day One, written at 8:30 PM local on Nov 1 (01:30 UTC on Nov 2).
    insert(db, 'diary', { id: 'd3', source: 'dayone-diary/default', date: '2026-11-02T01:30:00Z', text: 'Evening walk by the beach', metadata: '{"location":{"localityName":"Fort Lauderdale"},"starred":true}' });
    insert(db, 'diary', { id: 'd4', source: md, date: '2026-10-28T08:00:00', text: 'Worried about the deadline', metadata: '{"type":"concern"}' });
    insert(db, 'diary', { id: 'd5', source: md, date: '2025-11-01T10:00:00', text: 'A year ago today', metadata: '{"type":"journal"}' });
    insert(db, 'diary', { id: 'd6', source: md, date: '2024-11-01T10:00:00', text: 'Two years ago, coffee again', metadata: '{"type":"journal"}' });
    insert(db, 'diary', { id: 'd7', source: md, date: '2026-10-01T10:00:00', text: 'x'.repeat(5000), metadata: '{"type":"journal"}' });
    return db;
  }

  test('today by default, by local day: the evening Day One entry is on Nov 1', async () => {
    const { data } = parse(await listDiary({}, ctxFor(diaryDb())));
    expect(data).toMatchObject({ range: 'today', date: '2026-11-01', total: 3 });
    expect(data.entries.map(e => e.id)).toEqual(['d3', 'd2', 'd1']);
    expect(data.entries[0]).toMatchObject({ date: '2026-11-01', time: '2026-11-01T20:30:00-05:00', location: 'Fort Lauderdale', starred: true });
    expect(data.entries[2]).toMatchObject({ type: 'gratitude', time: null });
    expect(data.by_type).toEqual({ entry: 1, progress: 1, gratitude: 1 });
  });

  test('a date shows that day; week, on_this_day and recent ranges', async () => {
    const db = diaryDb();
    expect(parse(await listDiary({ date: '2026-11-02' }, ctxFor(db))).data.total).toBe(0);
    expect(parse(await listDiary({ range: 'week' }, ctxFor(db))).data.entries.map(e => e.id)).toEqual(['d3', 'd2', 'd1', 'd4']);
    expect(parse(await listDiary({ range: 'on_this_day' }, ctxFor(db))).data.entries.map(e => e.id)).toEqual(['d5', 'd6']);
    const recent = parse(await listDiary({ range: 'recent', limit: 2 }, ctxFor(db))).data;
    expect(recent).toMatchObject({ total: 7, returned: 2, has_more: true });
  });

  test('mixed UTC and local timestamps sort by when they were written, before the limit', async () => {
    const db = makeDb('diary');
    // 22:00 local (markdown) is newer than 21:30 local (Day One, 02:30 UTC next day).
    insert(db, 'diary', { id: 'm1', source: 'markdown-diary/default', date: '2026-11-01T22:00:00', text: 'Late note', metadata: '{}' });
    insert(db, 'diary', { id: 'j1', source: 'dayone-diary/default', date: '2026-11-02T02:30:00Z', text: 'Day One evening', metadata: '{}' });
    insert(db, 'diary', { id: 'm0', source: 'markdown-diary/default', date: '2026-10-31T08:00:00', text: 'Older', metadata: '{}' });
    const recent = parse(await listDiary({ range: 'recent', limit: 1 }, ctxFor(db))).data;
    expect(recent.entries.map(e => e.id)).toEqual(['m1']);
    expect(recent).toMatchObject({ total: 3, has_more: true });
    expect(parse(await listDiary({ range: 'recent', limit: 3 }, ctxFor(db))).data.entries.map(e => e.id)).toEqual(['m1', 'j1', 'm0']);
    expect(parse(await listDiary({ date: '2026-11-01' }, ctxFor(db))).data.entries.map(e => e.id)).toEqual(['m1', 'j1']);
  });

  test('recent: the count, the cutoff and the rows are read in one transaction', async () => {
    const { db, log } = trackReads(diaryDb());
    const { data } = parse(await listDiary({ range: 'recent', limit: 2 }, ctxFor(db)));
    expect(data).toMatchObject({ total: 7, returned: 2, has_more: true });
    expect(log).toEqual([true, true, true]);
  });

  test('on_this_day in a non-leap year finds a Day One entry stored on Feb 29 UTC', async () => {
    const db = makeDb('diary');
    // 2024-02-29 03:00 UTC is 22:00 on Feb 28 in New York.
    insert(db, 'diary', { id: 'leap', source: 'dayone-diary/default', date: '2024-02-29T03:00:00Z', text: 'Late on the 28th', metadata: '{}' });
    insert(db, 'diary', { id: 'leapday', source: 'dayone-diary/default', date: '2024-02-29T15:00:00Z', text: 'On the 29th', metadata: '{}' });
    const { data } = parse(await listDiary({ date: '2027-02-28', range: 'on_this_day' }, ctxFor(db)));
    expect(data.entries.map(e => [e.id, e.date])).toEqual([['leap', '2024-02-28']]);
  });

  test('query alone searches everything; with a range it narrows; long text is cut', async () => {
    const db = diaryDb();
    expect(parse(await listDiary({ query: 'coffee' }, ctxFor(db))).data.entries.map(e => e.id)).toEqual(['d1', 'd6']);
    expect(parse(await listDiary({ query: 'coffee', range: 'on_this_day' }, ctxFor(db))).data.entries.map(e => e.id)).toEqual(['d6']);
    const long = parse(await listDiary({ date: '2026-10-01' }, ctxFor(db))).data.entries[0];
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(2001);
    expect((await listDiary({ range: 'month' }, ctxFor(db))).isError).toBe(true);
  });
});

describe('health', () => {
  function healthDb() {
    const db = makeDb('health');
    const src = 'apple-health-auto-export/default';
    let n = 0;
    const add = (date, metric, value, units) => insert(db, 'health_metrics', { id: `h${n++}`, source: src, date, metric_name: metric, value, units });
    add('2026-11-01', 'step_count', 8123.4, 'count');
    add('2026-11-01', 'resting_heart_rate', 58, 'bpm');
    add('2026-11-01', 'dietary_water', 1.5, 'L');
    add('2026-10-31', 'step_count', 4000, 'count');
    add('2026-10-30', 'resting_heart_rate', 62, 'bpm');
    add('2026-10-30', 'heart_rate', 75, 'bpm');
    add('2026-10-01', 'step_count', 20000, 'count');
    add('2026-11-02', 'step_count', 999, 'count'); // tomorrow locally, ignored
    return db;
  }

  test('health_today: key metrics for the local day, the rest named', async () => {
    const { data } = parse(await healthToday({}, ctxFor(healthDb())));
    expect(data.date).toBe('2026-11-01');
    expect(data.metrics.map(m => [m.metric, m.formatted])).toEqual([['step_count', '8,123'], ['resting_heart_rate', '58 bpm']]);
    expect(data.other_metrics).toEqual(['dietary_water']);
    expect(parse(await healthToday({ all: true }, ctxFor(healthDb()))).data.metrics).toHaveLength(3);
  });

  test('health_summary: averages over the window', async () => {
    const { data } = parse(await healthSummary({ days: 7 }, ctxFor(healthDb())));
    expect(data).toMatchObject({ from: '2026-10-26', to: '2026-11-01' });
    const steps = data.metrics.find(m => m.metric === 'step_count');
    expect(steps).toMatchObject({ average: 6061.7, min: 4000, max: 8123.4, days_with_data: 2 });
    expect(data.other_metrics).toEqual(expect.arrayContaining(['dietary_water', 'heart_rate']));
  });

  test('weight and distance keep the units they were stored in; mixed units are not averaged together', async () => {
    const db = healthDb();
    const add = (id, date, metric, value, units, source = 'apple-health-auto-export/default') => insert(db, 'health_metrics', { id, source, date, metric_name: metric, value, units });
    add('w1', '2026-11-01', 'weight_body_mass', 70, 'kg');
    add('w2', '2026-10-31', 'weight_body_mass', 154.3, 'lb', 'other-scale/default');
    add('w3', '2026-10-30', 'weight_body_mass', 71, 'kg');
    add('d1', '2026-11-01', 'distance_walking_running', 3.2, 'mi');
    const today = parse(await healthToday({ all: true }, ctxFor(db))).data.metrics;
    expect(today.find(m => m.metric === 'weight_body_mass').formatted).toBe('70 kg');
    expect(today.find(m => m.metric === 'distance_walking_running').formatted).toBe('3.20 mi');

    const summary = parse(await healthSummary({ days: 7 }, ctxFor(db))).data.metrics.filter(m => m.metric === 'weight_body_mass');
    expect(summary.map(m => [m.units, m.average, m.average_formatted]).sort()).toEqual([['kg', 70.5, '70.5 kg'], ['lb', 154.3, '154.3 lbs']]);

    const one = parse(await healthSummary({ metric: 'weight_body_mass' }, ctxFor(db))).data;
    expect(one.stats).toBeNull();
    expect(one.stats_by_units).toEqual({ kg: { average: 70.5, min: 70, max: 71 }, lb: { average: 154.3, min: 154.3, max: 154.3 } });
    expect(one.history.map(h => h.formatted)).toEqual(['70 kg', '154.3 lbs', '71 kg']);
  });

  test('any formatter unit the stored unit does not match is replaced by the stored one', async () => {
    const db = healthDb();
    const add = (id, date, metric, value, units) => insert(db, 'health_metrics', { id, source: 'apple-health-auto-export/default', date, metric_name: metric, value, units });
    add('u1', '2026-11-01', 'dietary_water', 500, 'mL');
    add('u2', '2026-11-01', 'active_energy', 1200, 'kJ');
    add('u3', '2026-11-01', 'sleep_analysis', 7.5, 'hr');
    add('u4', '2026-11-01', 'respiratory_rate', 14.2, 'count/min');
    add('u5', '2026-11-01', 'dietary_caffeine', 0.25, 'g');
    const today = parse(await healthToday({ all: true }, ctxFor(db))).data.metrics;
    const shown = name => today.filter(m => m.metric === name).map(m => m.formatted);
    expect(shown('dietary_water').sort()).toEqual(['1.5 L', '500 mL']);
    expect(shown('active_energy')).toEqual(['1200 kJ']);
    expect(shown('sleep_analysis')).toEqual(['7.5 hrs']);
    expect(shown('respiratory_rate')).toEqual(['14.2 /min']);
    expect(shown('dietary_caffeine')).toEqual(['0.25 g']);
    expect(shown('resting_heart_rate')).toEqual(['58 bpm']);
    const summary = parse(await healthSummary({ days: 1, all: true }, ctxFor(db))).data.metrics.filter(m => m.metric === 'dietary_water');
    expect(summary.map(m => [m.units, m.average_formatted]).sort()).toEqual([['L', '1.5 L'], ['mL', '500 mL']]);
  });

  test('health_summary with metric: only the requested source\'s metrics are candidates', async () => {
    const db = makeDb('health');
    insert(db, 'health_metrics', { id: 'a', source: 'watch/default', date: '2026-11-01', metric_name: 'heart_rate', value: 70, units: 'bpm' });
    insert(db, 'health_metrics', { id: 'b', source: 'ring/default', date: '2026-11-01', metric_name: 'resting_heart_rate', value: 55, units: 'bpm' });
    expect((await healthSummary({ metric: 'heart' }, ctxFor(db))).isError).toBe(true);
    const watch = parse(await healthSummary({ metric: 'heart', source: 'watch' }, ctxFor(db))).data;
    expect(watch).toMatchObject({ metric: 'heart_rate', count: 1 });
    const ring = parse(await healthSummary({ metric: 'heart', source: 'ring' }, ctxFor(db))).data;
    expect(ring.metric).toBe('resting_heart_rate');
    const none = await healthSummary({ metric: 'resting', source: 'watch' }, ctxFor(db));
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toMatch(/in source "watch"\. Metrics with data: heart_rate\.$/);
  });

  test('health_summary with metric: history is capped, count and stats cover every reading', async () => {
    const db = makeDb('health');
    for (let i = 0; i < 5; i++) {
      insert(db, 'health_metrics', { id: `s${i}`, source: 'apple-health-auto-export/default', date: addDays('2026-11-01', -i), metric_name: 'step_count', value: 1000 * (i + 1), units: 'count' });
    }
    const { lead, data } = parse(await healthSummary({ metric: 'step_count', limit: 2 }, ctxFor(db)));
    expect(data).toMatchObject({ count: 5, returned: 2, limit: 2, has_more: true, stats: { average: 3000, min: 1000, max: 5000 } });
    expect(data.history.map(h => h.date)).toEqual(['2026-11-01', '2026-10-31']);
    expect(lead).toMatch(/history shows the newest 2/);
    expect(parse(await healthSummary({ metric: 'step_count' }, ctxFor(db))).data).toMatchObject({ returned: 5, limit: 100, has_more: false });
  });

  test('health_summary with metric: exact name wins over a substring, labels work, unknowns list what exists', async () => {
    const db = healthDb();
    const hr = parse(await healthSummary({ metric: 'heart_rate' }, ctxFor(db))).data;
    expect(hr.metric).toBe('heart_rate');
    expect(hr.history.map(h => h.value)).toEqual([75]);
    const rhr = parse(await healthSummary({ metric: 'Resting HR' }, ctxFor(db))).data;
    expect(rhr.metric).toBe('resting_heart_rate');
    expect(rhr.stats).toEqual({ average: 60, min: 58, max: 62 });
    const unknown = await healthSummary({ metric: 'blood sugar' }, ctxFor(db));
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toMatch(/step_count/);
  });
});

describe('habits', () => {
  function habitsDb() {
    const db = makeDb('habits');
    const src = 'streaks-habits/default';
    let n = 0;
    const add = (date, habit, title, status, streak, extra = {}) => insert(db, 'habits', {
      id: `x${n++}`, source: src, habit_id: habit, title, date, status, metadata: JSON.stringify({ current_streak: streak, ...extra }), ...(extra.row || {}),
    });
    add('2026-11-01', 'walk', 'Walk 30 minutes', 'completed', 12);
    add('2026-11-01', 'read', 'Read', 'pending', 0);
    add('2026-11-01', 'water', 'Drink water', 'completed', 3);
    add('2026-10-31', 'walk', 'Walk 30 minutes', 'completed', 11);
    add('2026-10-30', 'walk', 'Walk 30 minutes', 'skipped', 0);
    add('2026-10-31', 'readlater', 'Read later list', 'completed', 1);
    return db;
  }

  test('habit_streaks: longest first, min and habit filters', async () => {
    const db = habitsDb();
    const all = parse(await habitStreaks({}, ctxFor(db))).data;
    expect(all.as_of).toBe('2026-11-01');
    expect(all.streaks.map(s => [s.title, s.streak])).toEqual([['Walk 30 minutes', 12], ['Drink water', 3]]);
    expect(parse(await habitStreaks({ min: 5 }, ctxFor(db))).data.total).toBe(1);
    expect(parse(await habitStreaks({ min: 0, habit: 'read' }, ctxFor(db))).data.streaks.map(s => s.title)).toEqual(['Read']);
  });

  test('habit_streaks falls back to the newest synced day', async () => {
    const db = habitsDb();
    db.prepare("DELETE FROM habits WHERE date = '2026-11-01'").run();
    const { lead, data } = parse(await habitStreaks({}, ctxFor(db)));
    expect(data.as_of).toBe('2026-10-31');
    expect(lead).toMatch(/as of 2026-10-31/);
  });

  test('habit_streaks reads each source at its own newest day', async () => {
    const db = habitsDb();
    insert(db, 'habits', { id: 'r1', source: 'markdown-routines/default', habit_id: 'morning', title: 'Morning routine', date: '2026-10-29', status: 'completed', metadata: '{"current_streak":4}' });
    const { lead, data } = parse(await habitStreaks({}, ctxFor(db)));
    expect(data.streaks.map(s => [s.title, s.streak, s.as_of])).toEqual([
      ['Walk 30 minutes', 12, '2026-11-01'], ['Morning routine', 4, '2026-10-29'], ['Drink water', 3, '2026-11-01'],
    ]);
    expect(data.sources).toEqual([
      { source: 'markdown-routines/default', as_of: '2026-10-29' },
      { source: 'streaks-habits/default', as_of: '2026-11-01' },
    ]);
    expect(lead).toMatch(/markdown-routines\/default as of 2026-10-29/);
  });

  test('habit_history: one habit_id in two sources is ambiguous; source picks one', async () => {
    const db = habitsDb();
    insert(db, 'habits', { id: 'o1', source: 'streaks-habits/phone2', habit_id: 'walk', title: 'Walk 30 minutes', date: '2026-11-01', status: 'skipped', metadata: '{"current_streak":0}' });
    const both = await habitHistory({ habit: 'walk' }, ctxFor(db));
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toMatch(/matches 2 habits.*phone2/);
    const phone2 = parse(await habitHistory({ habit: 'walk', source: 'phone2' }, ctxFor(db))).data;
    expect(phone2).toMatchObject({ source: 'streaks-habits/phone2', counts: { skipped: 1 }, current_streak: 0 });
    expect(phone2.history).toHaveLength(1);
  });

  test('habit_history: exact title first, ambiguity refused, counts and streak', async () => {
    const db = habitsDb();
    const walk = parse(await habitHistory({ habit: 'walk' }, ctxFor(db))).data;
    expect(walk).toMatchObject({ habit_id: 'walk', current_streak: 12, counts: { completed: 2, skipped: 1 } });
    expect(walk.history.map(h => h.date)).toEqual(['2026-11-01', '2026-10-31', '2026-10-30']);
    // "Read" is an exact title, so "Read later list" doesn't make it ambiguous.
    expect(parse(await habitHistory({ habit: 'read' }, ctxFor(db))).data.habit_id).toBe('read');
    const vague = await habitHistory({ habit: 'r' }, ctxFor(db));
    expect(vague.isError).toBe(true);
    expect(vague.content[0].text).toMatch(/matches \d habits/);
    expect((await habitHistory({ habit: 'juggle' }, ctxFor(db))).isError).toBe(true);
  });
});

describe('finance', () => {
  function financeDb() {
    const db = makeDb('finance');
    ensureAccountBalancesTable(db);
    db.exec(`CREATE TABLE budget_allocations (id TEXT PRIMARY KEY, source TEXT, month TEXT, category TEXT,
      category_group TEXT, assigned REAL, activity REAL, available REAL, metadata TEXT)`);
    const src = 'ynab-api/default';
    let n = 0;
    const tx = row => insert(db, 'financial_transactions', { id: `t${n++}`, source: src, account: 'Checking', ...row });
    tx({ date: '2026-11-01', payee: 'Grocer', category: 'Groceries', amount: -54.321 });
    tx({ date: '2026-10-25', payee: 'Employer', category: 'Inflow', amount: 2000 });
    tx({ date: '2026-10-20', payee: 'Mystery', category: null, amount: -12, metadata: '{"budget_id":"b","ynab_id":"y"}' });
    tx({ date: '2026-10-19', payee: 'Cash', category: 'Uncategorized', amount: -40 });
    tx({ date: '2026-10-18', payee: 'Savings', category: null, amount: -100, transfer: 1 });
    tx({ date: '2026-11-02', payee: 'Landlord', category: 'Rent', amount: -1500, scheduled: 1, metadata: '{"frequency":"monthly"}' });
    tx({ date: '2027-03-01', payee: 'Far off', category: 'Rent', amount: -1500, scheduled: 1 });
    tx({ date: '2026-11-01', payee: 'Old copy', category: null, amount: -54.32, superseded_by: 't0' });
    insert(db, 'account_balances', { id: 'b:acc', source: src, budget_id: 'b', account: 'Checking', balance: 1234.5, cleared_balance: 1200, as_of: '2026-11-01T20:00:00Z' });
    const alloc = (id, month, category, group, assigned, activity, available) => insert(db, 'budget_allocations', { id, source: 'ynab-finance/default', month, category, category_group: group, assigned, activity, available });
    alloc('a1', '2026-11-01', 'Groceries', 'Everyday', 400, -450, -50);
    alloc('a2', '2026-11-01', 'Dining', 'Everyday', 200, -50, 150);
    alloc('a3', '2026-11-01', 'Rent', 'Bills', 1500, 0, 1500);
    alloc('a4', '2026-10-01', 'Groceries', 'Everyday', 400, -300, 100);
    return db;
  }

  test('accounts: the stored balance, as of a local time', async () => {
    const { data } = parse(await financeOverview({ view: 'accounts' }, ctxFor(financeDb())));
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]).toMatchObject({ account: 'Checking', balance: 1234.5, partial: false, as_of: '2026-11-01T15:00:00-05:00' });
  });

  test('upcoming: scheduled rows from local today, within the window', async () => {
    const { data } = parse(await financeOverview({ view: 'upcoming' }, ctxFor(financeDb())));
    expect(data).toMatchObject({ from: '2026-11-01', to: '2026-12-01', total_count: 1, net_total: -1500 });
    expect(data.transactions[0]).toMatchObject({ payee: 'Landlord', frequency: 'monthly' });
    expect(parse(await financeOverview({ view: 'upcoming', days: 200 }, ctxFor(financeDb()))).data.total_count).toBe(2);
  });

  test('upcoming: the list is capped, totals cover every row', async () => {
    const db = financeDb();
    for (let i = 0; i < 5; i++) {
      insert(db, 'financial_transactions', { id: `s${i}`, source: 'ynab-api/default', account: 'Checking', date: `2026-11-1${i}`, payee: `Bill ${i}`, amount: -10, scheduled: 1 });
    }
    const { lead, data } = parse(await financeOverview({ view: 'upcoming', limit: 2 }, ctxFor(db)));
    expect(data).toMatchObject({ total_count: 6, net_total: -1550, returned: 2, limit: 2, has_more: true });
    expect(data.transactions.map(t => t.payee)).toEqual(['Landlord', 'Bill 0']);
    expect(lead).toMatch(/showing the first 2/);
  });

  test('accounts: transaction stats and summed balances stop at local today, not the UTC day', async () => {
    const db = financeDb();
    // An account with no stored balance; one row dated local tomorrow.
    insert(db, 'financial_transactions', { id: 'p1', source: 'ynab-api/default', account: 'Wallet', date: '2026-11-01', payee: 'Cafe', amount: -5 });
    insert(db, 'financial_transactions', { id: 'p2', source: 'ynab-api/default', account: 'Wallet', date: '2026-11-02', payee: 'Tomorrow', amount: -7 });
    insert(db, 'financial_transactions', { id: 'p3', source: 'ynab-api/default', account: 'Future only', date: '2026-11-02', payee: 'Later', amount: -1 });
    const { data } = parse(await financeOverview({ view: 'accounts' }, ctxFor(db)));
    expect(data.accounts.map(a => a.account)).toEqual(['Checking', 'Wallet']);
    expect(data.accounts[1]).toMatchObject({ balance: -5, partial: true, transactions_cached: 1, last_transaction: '2026-11-01' });
    expect(data.accounts[0]).toMatchObject({ balance: 1234.5, partial: false, last_transaction: '2026-11-01' });
  });

  test('accounts: the same name in two budgets or two sources is kept apart', async () => {
    const db = makeDb('finance');
    ensureAccountBalancesTable(db);
    const src = 'ynab-api/default';
    insert(db, 'account_balances', { id: 'b1:c', source: src, budget_id: 'b1', budget_name: 'Home', account_id: 'c1', account: 'Checking', balance: 100, as_of: '2026-11-01T20:00:00Z' });
    insert(db, 'account_balances', { id: 'b2:c', source: src, budget_id: 'b2', budget_name: 'Work', account_id: 'c2', account: 'Checking', balance: 200, as_of: '2026-11-01T20:00:00Z' });
    const tx = (id, date, meta, source = src) => insert(db, 'financial_transactions', { id, source, account: 'Checking', date, payee: 'x', amount: -1, metadata: meta && JSON.stringify(meta) });
    tx('h1', '2026-10-30', { budget_id: 'b1', account_id: 'c1' });
    tx('h2', '2026-10-31', { budget_id: 'b1', account_id: 'c1' });
    tx('w1', '2026-10-20', { budget_id: 'b2', account_id: 'c2' });
    tx('k1', '2026-11-01', null, 'csv-bank/default');
    tx('k2', '2026-10-15', null, 'csv-bank/default');
    const { data } = parse(await financeOverview({ view: 'accounts' }, ctxFor(db)));
    const rows = data.accounts.map(a => [a.source, a.budget_name, a.balance, a.partial, a.transactions_cached, a.last_transaction]);
    expect(rows).toEqual(expect.arrayContaining([
      [src, 'Home', 100, false, 2, '2026-10-31'],
      [src, 'Work', 200, false, 1, '2026-10-20'],
      ['csv-bank/default', null, -2, true, 2, '2026-11-01'],
    ]));
    expect(rows).toHaveLength(3);
  });

  test('accounts: % and _ in source are literal, not wildcards', async () => {
    const db = makeDb('finance');
    ensureAccountBalancesTable(db);
    insert(db, 'account_balances', { id: 'one', source: 'work_1', account: 'Payroll', balance: 10, as_of: '2026-11-01T20:00:00Z' });
    insert(db, 'account_balances', { id: 'other', source: 'workA1', account: 'Other', balance: 20, as_of: '2026-11-01T20:00:00Z' });
    insert(db, 'financial_transactions', { id: 'o1', source: 'workA1', account: 'Stray', date: '2026-11-01', payee: 'x', amount: -3 });
    const { data } = parse(await financeOverview({ view: 'accounts', source: 'work_1' }, ctxFor(db)));
    expect(data.accounts.map(a => a.account)).toEqual(['Payroll']);
    expect(parse(await financeOverview({ view: 'accounts', source: 'work%' }, ctxFor(db))).data.accounts).toEqual([]);
  });

  test('budget: over and under lists report their full counts and can be raised past ten', async () => {
    const db = financeDb();
    for (let i = 0; i < 10; i++) {
      insert(db, 'budget_allocations', { id: `o${i}`, source: 'ynab-finance/default', month: '2026-11-01', category: `Over ${i}`, category_group: 'Extra', assigned: 10, activity: -20 - i, available: -10 - i });
    }
    const { lead, data } = parse(await financeOverview({ view: 'budget' }, ctxFor(db)));
    expect(data).toMatchObject({ list_limit: 10, over_budget_count: 11, over_budget_truncated: true, under_budget_count: 1, under_budget_truncated: false });
    expect(data.over_budget).toHaveLength(10);
    expect(lead).toMatch(/11 overspent\. Showing 10 of 11 over budget \(raise limit/);
    const all = parse(await financeOverview({ view: 'budget', limit: 50 }, ctxFor(db))).data;
    expect(all).toMatchObject({ list_limit: 50, over_budget_count: 11, over_budget_truncated: false });
    expect(all.over_budget).toHaveLength(11);
  });

  test('budget: a category overspent with nothing assigned counts as over budget', async () => {
    const db = financeDb();
    insert(db, 'budget_allocations', { id: 'a5', source: 'ynab-finance/default', month: '2026-11-01', category: 'Gifts', category_group: 'Everyday', assigned: 0, activity: -30, available: -30 });
    const { data } = parse(await financeOverview({ view: 'budget' }, ctxFor(db)));
    expect(data.over_budget.map(c => [c.category, c.percent_used])).toEqual([['Gifts', null], ['Groceries', 112.5]]);
  });

  test('recent: no scheduled or superseded rows, totals without transfers, filters and limit', async () => {
    const db = financeDb();
    const { data } = parse(await financeOverview({ view: 'recent' }, ctxFor(db)));
    expect(data.transactions.map(t => t.payee)).toEqual(['Grocer', 'Employer', 'Mystery', 'Cash', 'Savings']);
    expect(data).toMatchObject({ total: 5, income: 2000, expenses: -106.32 });
    expect(data.transactions[0].amount).toBe(-54.32);
    expect(parse(await financeOverview({ view: 'recent', category: 'groc' }, ctxFor(db))).data.total).toBe(1);
    expect(parse(await financeOverview({ view: 'recent', limit: 2 }, ctxFor(db))).data).toMatchObject({ returned: 2, has_more: true });
  });

  test('budget: this local month by default, over and under, groups, a category, another month', async () => {
    const db = financeDb();
    const { data } = parse(await financeOverview({ view: 'budget' }, ctxFor(db)));
    expect(data.month).toBe('2026-11');
    expect(data.totals).toEqual({ assigned: 2100, activity: -500, available: 1600 });
    expect(data.over_budget.map(c => [c.category, c.percent_used])).toEqual([['Groceries', 112.5]]);
    expect(data.under_budget.map(c => c.category)).toEqual(['Dining']);
    expect(data.by_group.map(g => g.category_group)).toEqual(['Bills', 'Everyday']);
    expect(parse(await financeOverview({ view: 'budget', category: 'groc', month: '2026-10' }, ctxFor(db))).data.categories)
      .toEqual([expect.objectContaining({ category: 'Groceries', available: 100 })]);
    expect((await financeOverview({ view: 'budget', month: 'November' }, ctxFor(db))).isError).toBe(true);
  });

  test('budget with no budget table says so', async () => {
    const db = makeDb('finance');
    const { lead } = parse(await financeOverview({ view: 'budget' }, ctxFor(db)));
    expect(lead).toMatch(/No budget data/);
  });

  test('an unknown view is refused', async () => {
    expect((await financeOverview({ view: 'networth' }, ctxFor(financeDb()))).isError).toBe(true);
  });

  test('uncategorized_transactions: fixable rows only, with writable flags', async () => {
    const { data } = parse(await uncategorizedTransactions({}, ctxFor(financeDb())));
    expect(data.transactions.map(t => [t.payee, t.writable])).toEqual([['Mystery', true], ['Cash', false]]);
    expect(data).toMatchObject({ total: 2, from: '2026-09-02', to: '2026-11-01' });
    expect(parse(await uncategorizedTransactions({ days: 12 }, ctxFor(financeDb()))).data.total).toBe(1);
  });

  test('uncategorized_transactions: the total and the page are read in one transaction', async () => {
    const { db, log } = trackReads(financeDb());
    expect(parse(await uncategorizedTransactions({ limit: 1 }, ctxFor(db))).data).toMatchObject({ total: 2, returned: 1, has_more: true });
    expect(log).toEqual([true, true]);
  });
});

test('the registry loads these tools as reads with their plugin types', async () => {
  setRegisteredToolsForTesting(null);
  const tools = await getRegisteredTools();
  const expected = {
    list_emails: 'email', search_email: 'email', get_email: 'email',
    upcoming_birthdays: 'contacts', search_contacts: 'contacts',
    list_diary: 'diary',
    health_today: 'health', health_summary: 'health',
    habit_streaks: 'habits', habit_history: 'habits',
    finance_overview: 'finance', uncategorized_transactions: 'finance',
  };
  for (const [name, pluginType] of Object.entries(expected)) {
    expect(tools.get(name)).toMatchObject({ kind: 'read', pluginType });
  }
});
