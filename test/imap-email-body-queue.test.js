import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { getPendingBodies } from '../plugins/imap-email/body-queue.js';

describe('IMAP body queue selection', () => {
  let dir;
  let dbPath;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-body-queue-'));
    dbPath = path.join(dir, 'today.db');
    db = new Database(dbPath);
    db.exec(`CREATE TABLE email (
      source TEXT, folder TEXT, size INTEGER, metadata TEXT,
      snippet TEXT, text_content TEXT, html_content TEXT, attachments TEXT
    )`);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function add(source, folder, uid, needsBody) {
    db.prepare(`INSERT INTO email (source, folder, size, metadata, text_content)
      VALUES (?, ?, 100, ?, ?)`)
      .run(source, folder, JSON.stringify({ uid, needs_body: needsBody }), 'cached body');
  }

  test('requeues unfinished rows on a later sync with no new messages, without selecting bodies', () => {
    add('imap-email/test', 'INBOX', 1, true);
    add('imap-email/test', 'Archive', 2, true);
    add('imap-email/test', 'INBOX', 3, false);
    add('imap-email/test', 'INBOX', 4, undefined);
    add('imap-email/other', 'INBOX', 5, true);

    expect(getPendingBodies(dbPath, 'imap-email/test')).toEqual([
      { folder: 'INBOX', uid: 1, size: 100 },
      { folder: 'Archive', uid: 2, size: 100 }
    ]);

    db.prepare(`UPDATE email SET metadata = json_set(metadata, '$.needs_body', false)`).run();
    expect(getPendingBodies(dbPath, 'imap-email/test')).toEqual([]);
  });

  test('merges new work without duplicating a folder/UID or conflating folders', () => {
    add('imap-email/test', 'INBOX', 1, true);
    const fresh = [
      { folder: 'INBOX', uid: 1, size: 200 },
      { folder: 'Archive', uid: 1, size: 300 }
    ];
    expect(getPendingBodies(dbPath, 'imap-email/test', fresh)).toEqual(fresh);
  });

  test('retains new work when no database exists yet', () => {
    const fresh = [{ folder: 'INBOX', uid: 1, size: 100 }];
    expect(getPendingBodies(path.join(dir, 'missing.db'), 'imap-email/test', fresh)).toEqual(fresh);
  });
});
