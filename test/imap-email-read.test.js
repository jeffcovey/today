import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const SOURCE = 'imap-email/test';
const LOCK = '/tmp/imap-email-fetch.lock';
let currentFolder;
let failedFolders;
let workerRunning;
let pendingWork;
const spawn = jest.fn(() => ({ unref: jest.fn() }));
const client = {
  connect: jest.fn(),
  logout: jest.fn(),
  getMailboxLock: jest.fn(async folder => {
    currentFolder = folder;
    return { release: jest.fn() };
  }),
  mailbox: { uidValidity: 1, uidNext: 11, highestModseq: 30n, exists: 2 },
  search: jest.fn(async () => [2, 10]),
  fetch: async function* () {
    yield { uid: 10, internalDate: new Date('2007-01-04'), flags: new Set() };
    if (failedFolders.has(currentFolder)) throw new Error('fetch interrupted');
  }
};

jest.unstable_mockModule('imapflow', () => ({
  ImapFlow: jest.fn(function () { return client; })
}));
jest.unstable_mockModule('child_process', () => ({ spawn }));
jest.unstable_mockModule('fs', () => ({
  default: {
    ...fs,
    existsSync: file => file === LOCK ? workerRunning : fs.existsSync(file),
    statSync: file => file === LOCK ? { mtimeMs: Date.now() } : fs.statSync(file),
    readFileSync: (file, ...args) => file === LOCK ? `${process.pid}:${SOURCE}` : fs.readFileSync(file, ...args),
    writeFileSync: (file, data, ...args) => {
      if (file.startsWith('/tmp/imap-bodies-')) pendingWork = JSON.parse(data);
      else fs.writeFileSync(file, data, ...args);
    }
  }
}));

describe('IMAP reader retries and folder cursors', () => {
  let dir;
  let db;
  let previous;
  let savedEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-read-'));
    fs.mkdirSync(path.join(dir, '.data'));
    db = new Database(path.join(dir, '.data', 'today.db'));
    db.exec(`
      CREATE TABLE sync_metadata (source TEXT PRIMARY KEY, extra_data TEXT);
      CREATE TABLE email (id TEXT PRIMARY KEY, source TEXT, folder TEXT, date TEXT,
        size INTEGER, flags TEXT, metadata TEXT, text_content TEXT);
    `);
    previous = {
      INBOX: { uidValidity: 1, uidNext: 10, highestModseq: '20' },
      Failed: { uidValidity: 1, uidNext: 10, highestModseq: '20' }
    };
    db.prepare('INSERT INTO sync_metadata VALUES (?, ?)').run(SOURCE, JSON.stringify({ folder_state: previous }));
    savedEnv = Object.fromEntries(
      ['PROJECT_ROOT', 'SOURCE_ID', 'LAST_SYNC_TIME', 'PLUGIN_CONFIG'].map(key => [key, process.env[key]])
    );
    process.env.PROJECT_ROOT = dir;
    process.env.SOURCE_ID = SOURCE;
    process.env.LAST_SYNC_TIME = '2026-11-01T00:00:00Z';
    failedFolders = new Set();
    workerRunning = false;
    pendingWork = undefined;
    spawn.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function read(config = {}) {
    jest.resetModules();
    process.env.PLUGIN_CONFIG = JSON.stringify({
      host: 'imap.example.test', username: 'test', password: 'not-a-real-password',
      folders: 'INBOX,Failed', include_body: false, ...config
    });
    const output = new Promise(resolve => {
      jest.spyOn(console, 'log').mockImplementation(value => resolve(JSON.parse(value)));
    });
    await import('../plugins/imap-email/read.js');
    return output;
  }

  test('advances a filtered-only folder but retains the cursor of a folder failing mid-fetch', async () => {
    failedFolders.add('Failed');
    const result = await read();
    expect(result.entries).toEqual([]);
    expect(result.metadata.skipped_outside_window).toBe(2);
    expect(result.metadata.folder_state).toEqual({
      INBOX: { uidValidity: 1, uidNext: 11, highestModseq: '30' },
      Failed: previous.Failed
    });
    expect(result.metadata.errors).toEqual(['Error syncing folder Failed: fetch interrupted']);
  });

  test('does not publish a cursor for a new folder failing mid-fetch', async () => {
    failedFolders.add('New');
    const result = await read({ folders: 'New' });
    expect(result.metadata.folder_state.New).toBeUndefined();
  });

  test.each([new Date('invalid'), undefined])('uses the internal date when the header date is %s and advances the cursor', async headerDate => {
    const internalDate = new Date();
    jest.spyOn(client, 'fetch').mockImplementation(async function* () {
      yield {
        uid: 10, internalDate, flags: new Set(),
        envelope: { date: headerDate }
      };
    });
    const result = await read({ folders: 'INBOX' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].date).toBe(internalDate.toISOString());
    expect(result.metadata.folder_state.INBOX).toEqual({
      uidValidity: 1, uidNext: 11, highestModseq: '30'
    });
    expect(result.metadata.errors).toEqual([]);
  });

  test.each([new Date('invalid'), undefined])('uses the current time when neither date is usable (%s)', async internalDate => {
    jest.spyOn(client, 'fetch').mockImplementation(async function* () {
      yield {
        uid: 10, internalDate, flags: new Set(),
        envelope: { date: new Date('invalid') }
      };
    });
    const before = Date.now();
    const result = await read({ folders: 'INBOX' });
    const after = Date.now();
    expect(result.entries).toHaveLength(1);
    const date = Date.parse(result.entries[0].date);
    expect(date).toBeGreaterThanOrEqual(before);
    expect(date).toBeLessThanOrEqual(after);
    expect(result.metadata.errors).toEqual([]);
  });

  test('prefers a valid header date over the internal date', async () => {
    const headerDate = new Date('2007-01-04');
    jest.spyOn(client, 'fetch').mockImplementation(async function* () {
      yield {
        uid: 10, internalDate: new Date(), flags: new Set(),
        envelope: { date: headerDate }
      };
    });
    const result = await read({ folders: 'INBOX' });
    expect(result.entries[0].date).toBe(headerDate.toISOString());
    expect(result.metadata.errors).toEqual([]);
  });

  test('logs and skips an unparseable message without holding back the cursor', async () => {
    jest.spyOn(client, 'fetch').mockImplementation(async function* () {
      yield {
        uid: 10, internalDate: new Date(), flags: new Set(),
        envelope: { to: {} }
      };
      yield { uid: 11, internalDate: new Date(), flags: new Set() };
    });
    const result = await read({ folders: 'INBOX' });
    expect(result.entries.map(entry => entry.id)).toEqual(['INBOX:11']);
    expect(result.metadata.folder_state.INBOX).toEqual({
      uidValidity: 1, uidNext: 11, highestModseq: '30'
    });
    expect(result.metadata.errors).toHaveLength(1);
    expect(result.metadata.errors[0]).toContain('Error parsing message 10');
  });

  test('later sync requeues needs_body rows skipped while a worker held the lock', async () => {
    db.prepare('INSERT INTO email (id, source, folder, date, size, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${SOURCE}:INBOX:2`, SOURCE, 'INBOX', new Date().toISOString(), 100,
        JSON.stringify({ uid: 2, needs_body: true }));
    workerRunning = true;
    const held = await read({ include_body: true });
    expect(held.entries).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(pendingWork).toBeUndefined();

    workerRunning = false;
    const retry = await read({ include_body: true });
    expect(retry.entries).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(pendingWork.emails).toEqual([{ folder: 'INBOX', uid: 2, size: 100 }]);
    expect(retry.metadata.bodies_pending).toBe(1);
    expect(JSON.stringify(retry)).not.toContain('text_content');
  });
});
