import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  findStaleIds,
  isTrustworthyUidList,
  reconcileFolder,
  searchSince,
  WINDOW_SLACK_DAYS
} from '../plugins/imap-email/reconcile.js';

const SOURCE = 'imap-email/test';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function makeDb(dbPath, rows) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE email (
      id TEXT PRIMARY KEY,
      source TEXT,
      folder TEXT,
      subject TEXT,
      date TEXT,
      metadata TEXT
    )
  `);
  const stmt = db.prepare(
    'INSERT INTO email (id, source, folder, subject, date, metadata) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    const {
      uid,
      folder = 'INBOX',
      source = SOURCE,
      subject = 's',
      date = new Date().toISOString()
    } = row;
    stmt.run(
      `${source}:${folder}:${uid}`,
      source,
      folder,
      subject,
      date,
      JSON.stringify({ uid })
    );
  }
  db.close();
}

function remainingUids(dbPath, folder = 'INBOX', source = SOURCE) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT json_extract(metadata, '$.uid') AS uid FROM email
       WHERE source = ? AND folder = ? ORDER BY uid`
    )
    .all(source, folder);
  db.close();
  return rows.map(r => Number(r.uid));
}

describe('searchSince', () => {
  it('asks the server for a wider span than the deletion window', () => {
    const since = new Date('2026-09-01T00:00:00Z');
    const padded = searchSince(since);
    const gapDays = (since - padded) / 86400000;
    expect(gapDays).toBe(WINDOW_SLACK_DAYS);
  });

  it('does not mutate the date it is given', () => {
    const since = new Date('2026-09-01T00:00:00Z');
    searchSince(since);
    expect(since.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('findStaleIds', () => {
  it('returns rows whose uid is gone from the server', () => {
    const rows = [{ id: 'a', uid: 1 }, { id: 'b', uid: 2 }, { id: 'c', uid: 3 }];
    expect(findStaleIds(rows, [1, 3])).toEqual(['b']);
  });

  it('returns nothing when every row is still present', () => {
    const rows = [{ id: 'a', uid: 1 }, { id: 'b', uid: 2 }];
    expect(findStaleIds(rows, [2, 1])).toEqual([]);
  });

  it('compares numerically when the server sends uids as strings', () => {
    const rows = [{ id: 'a', uid: 10 }, { id: 'b', uid: 11 }];
    expect(findStaleIds(rows, ['10'])).toEqual(['b']);
  });

  it('leaves rows without a usable uid alone', () => {
    const rows = [{ id: 'a', uid: null }, { id: 'b', uid: 'nope' }, { id: 'c', uid: 5 }];
    expect(findStaleIds(rows, [])).toEqual(['c']);
  });
});

describe('isTrustworthyUidList', () => {
  it('rejects a non-array, so a failed search never deletes', () => {
    expect(isTrustworthyUidList(undefined, { messageCount: 0, cachedRowCount: 0 })).toBe(false);
    expect(isTrustworthyUidList(null, { messageCount: 5, cachedRowCount: 5 })).toBe(false);
  });

  it('rejects an empty result that contradicts a populated cache', () => {
    expect(isTrustworthyUidList([], { messageCount: 42, cachedRowCount: 7 })).toBe(false);
  });

  it('accepts an empty result for a genuinely empty mailbox', () => {
    expect(isTrustworthyUidList([], { messageCount: 0, cachedRowCount: 3 })).toBe(true);
  });

  it('accepts an empty result when nothing is cached to contradict it', () => {
    expect(isTrustworthyUidList([], { messageCount: 100, cachedRowCount: 0 })).toBe(true);
  });

  it('accepts a populated list', () => {
    expect(isTrustworthyUidList([1, 2], { messageCount: 2, cachedRowCount: 2 })).toBe(true);
  });
});

describe('reconcileFolder', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-reconcile-'));
    dbPath = path.join(tempDir, 'today.db');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes cached rows for messages moved out of the folder', () => {
    makeDb(dbPath, [{ uid: 1 }, { uid: 2 }, { uid: 3 }]);

    const removed = reconcileFolder(dbPath, SOURCE, 'INBOX', [1, 3], { messageCount: 2 });

    expect(removed).toBe(1);
    expect(remainingUids(dbPath)).toEqual([1, 3]);
  });

  it('leaves other folders untouched', () => {
    makeDb(dbPath, [
      { uid: 1, folder: 'INBOX' },
      { uid: 1, folder: 'Archive' },
      { uid: 2, folder: 'Archive' }
    ]);

    reconcileFolder(dbPath, SOURCE, 'INBOX', [9], { messageCount: 1 });

    expect(remainingUids(dbPath, 'INBOX')).toEqual([]);
    expect(remainingUids(dbPath, 'Archive')).toEqual([1, 2]);
  });

  it('leaves other sources untouched', () => {
    makeDb(dbPath, [
      { uid: 1, source: SOURCE },
      { uid: 1, source: 'imap-email/other' }
    ]);

    reconcileFolder(dbPath, SOURCE, 'INBOX', [9], { messageCount: 1 });

    expect(remainingUids(dbPath, 'INBOX', SOURCE)).toEqual([]);
    expect(remainingUids(dbPath, 'INBOX', 'imap-email/other')).toEqual([1]);
  });

  it('keeps rows older than the deletion window', () => {
    makeDb(dbPath, [
      { uid: 1, date: daysAgo(400).toISOString() },
      { uid: 2, date: daysAgo(2).toISOString() }
    ]);

    // The server's windowed answer covers neither uid; only the recent row is
    // ours to delete, because only it falls inside the span we synced.
    const removed = reconcileFolder(dbPath, SOURCE, 'INBOX', [9], {
      messageCount: 1,
      deleteRowsSince: daysAgo(30).toISOString()
    });

    expect(removed).toBe(1);
    expect(remainingUids(dbPath)).toEqual([1]);
  });

  it('deletes nothing when the search comes back empty but the cache is not', () => {
    makeDb(dbPath, [{ uid: 1 }, { uid: 2 }]);

    const removed = reconcileFolder(dbPath, SOURCE, 'INBOX', [], { messageCount: 2 });

    expect(removed).toBe(0);
    expect(remainingUids(dbPath)).toEqual([1, 2]);
  });

  it('deletes nothing when the search failed outright', () => {
    makeDb(dbPath, [{ uid: 1 }]);

    expect(reconcileFolder(dbPath, SOURCE, 'INBOX', undefined, { messageCount: 1 })).toBe(0);
    expect(remainingUids(dbPath)).toEqual([1]);
  });

  it('empties the cache for a folder the user emptied', () => {
    makeDb(dbPath, [{ uid: 1 }, { uid: 2 }]);

    expect(reconcileFolder(dbPath, SOURCE, 'INBOX', [], { messageCount: 0 })).toBe(2);
    expect(remainingUids(dbPath)).toEqual([]);
  });

  it('is a no-op when the cache already matches', () => {
    makeDb(dbPath, [{ uid: 1 }, { uid: 2 }]);

    expect(reconcileFolder(dbPath, SOURCE, 'INBOX', [1, 2], { messageCount: 2 })).toBe(0);
    expect(remainingUids(dbPath)).toEqual([1, 2]);
  });
});
