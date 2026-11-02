import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const LOCK = '/tmp/imap-email-fetch.lock';
const client = {
  connect: jest.fn(),
  logout: jest.fn(),
  getMailboxLock: jest.fn(async folder => {
    if (folder === 'Deleted') throw new Error('mailbox no longer exists');
    return { release: jest.fn() };
  }),
  fetchOne: jest.fn(async () => ({ source: Buffer.from('message') }))
};
jest.unstable_mockModule('imapflow', () => ({
  ImapFlow: jest.fn(function () { return client; })
}));
jest.unstable_mockModule('mailparser', () => ({
  simpleParser: jest.fn(async () => ({ text: 'fetched body', attachments: [] }))
}));
jest.unstable_mockModule('fs', () => ({
  default: {
    ...fs,
    existsSync: file => file === LOCK ? false : fs.existsSync(file),
    writeFileSync: (file, ...args) => {
      if (file !== LOCK) fs.writeFileSync(file, ...args);
    }
  }
}));

test('a deleted pending folder does not block body retries for other folders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-fetch-bodies-'));
  fs.mkdirSync(path.join(dir, '.data'));
  const db = new Database(path.join(dir, '.data', 'today.db'));
  db.exec(`CREATE TABLE email (
    id TEXT PRIMARY KEY, snippet TEXT, text_content TEXT, html_content TEXT,
    attachments TEXT, metadata TEXT
  )`);
  db.prepare('INSERT INTO email (id, metadata) VALUES (?, ?)')
    .run('imap-email/test:INBOX:2', JSON.stringify({ uid: 2, needs_body: true }));
  const pendingFile = path.join(dir, 'pending.json');
  fs.writeFileSync(pendingFile, JSON.stringify({
    sourceId: 'imap-email/test',
    config: { password: 'not-a-real-password', maxBodySize: 50000 },
    emails: [
      { folder: 'Deleted', uid: 1, size: 10 },
      { folder: 'INBOX', uid: 2, size: 100 }
    ]
  }));
  const oldRoot = process.env.PROJECT_ROOT;
  const oldArgv = process.argv;
  process.env.PROJECT_ROOT = dir;
  process.argv = [process.execPath, 'fetch-bodies.js', pendingFile];
  // Do not install worker process-exit handlers in the test runner.
  jest.spyOn(process, 'on').mockReturnValue(process);
  const done = new Promise(resolve => {
    jest.spyOn(console, 'error').mockImplementation(message => {
      if (message === '✓ Fetched 1 email bodies') resolve();
    });
  });
  try {
    await import('../plugins/imap-email/fetch-bodies.js');
    await done;
    expect(client.getMailboxLock.mock.calls).toEqual([['Deleted'], ['INBOX']]);
    expect(client.fetchOne).toHaveBeenCalledWith(2, { source: true }, { uid: true });
    const row = db.prepare('SELECT text_content, metadata FROM email').get();
    expect(row.text_content).toBe('fetched body');
    expect(JSON.parse(row.metadata).needs_body).toBe(0);
    expect(client.logout).toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
    process.argv = oldArgv;
    if (oldRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = oldRoot;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
