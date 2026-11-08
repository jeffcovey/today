import fs from 'fs';
import os from 'os';
import path from 'path';
import { findInboxSession, parseMarker, readInboxSession } from '../src/inbox-session.js';

const now = new Date('2026-11-08T18:00:00Z');
const marker = (action, time, description = 'Hosting') => ({ action, time: new Date(time), description });

describe('parseMarker', () => {
  test('reads the action, time and trimmed description', () => {
    expect(parseMarker('Start\n2026-11-08T11:54:24-05:00\n🔍 Reviews  \n')).toEqual({
      action: 'Start',
      time: new Date('2026-11-08T16:54:24Z'),
      description: '🔍 Reviews'
    });
  });

  test.each([
    ['an unknown action', 'Pause\n2026-11-08T11:54:24-05:00\nHosting'],
    ['a bad timestamp', 'Start\nsoon\nHosting'],
    ['an empty file', '']
  ])('rejects %s', (_name, content) => {
    expect(parseMarker(content)).toBeNull();
  });
});

describe('findInboxSession', () => {
  test('no markers, no session', () => {
    expect(findInboxSession([], { now })).toBeNull();
  });

  test('a Start with nothing after it is running', () => {
    expect(findInboxSession([marker('Start', '2026-11-08T17:30:00Z')], { now })).toEqual({
      description: 'Hosting',
      startTime: new Date('2026-11-08T17:30:00Z')
    });
  });

  test('a later Stop ends it', () => {
    expect(findInboxSession([
      marker('Start', '2026-11-08T17:00:00Z'),
      marker('Stop', '2026-11-08T17:30:00Z')
    ], { now })).toBeNull();
  });

  test('older unpaired Starts are leftovers', () => {
    const session = findInboxSession([
      marker('Start', '2026-11-07T12:55:01Z', 'Zazen'),
      marker('Start', '2026-11-08T16:54:24Z', 'Reviews'),
      marker('Start', '2026-11-08T17:32:42Z', 'Hosting')
    ], { now });
    expect(session.description).toBe('Hosting');
  });

  test('duplicates from several devices count from the earliest', () => {
    const session = findInboxSession([
      marker('Start', '2026-11-08T17:32:57Z'),
      marker('Start', '2026-11-08T17:32:42Z'),
      marker('Start', '2026-11-08T17:32:42Z')
    ], { now });
    expect(session.startTime).toEqual(new Date('2026-11-08T17:32:42Z'));
  });

  test('groups Starts chronologically against each earliest representative', () => {
    const session = findInboxSession([
      marker('Start', '2026-11-08T17:00:00Z'),
      marker('Start', '2026-11-08T17:00:20Z'),
      marker('Start', '2026-11-08T17:00:40Z')
    ], { now, dedupWindowSeconds: 30 });
    expect(session.startTime).toEqual(new Date('2026-11-08T17:00:40Z'));
  });

  test('a different activity moments earlier is not a duplicate', () => {
    const session = findInboxSession([
      marker('Start', '2026-11-08T17:32:42Z', 'Reviews'),
      marker('Start', '2026-11-08T17:32:50Z', 'Hosting')
    ], { now });
    expect(session).toEqual({ description: 'Hosting', startTime: new Date('2026-11-08T17:32:50Z') });
  });

  test('the same activity outside the window is a new session', () => {
    const session = findInboxSession([
      marker('Start', '2026-11-08T17:00:00Z'),
      marker('Start', '2026-11-08T17:30:00Z')
    ], { now });
    expect(session.startTime).toEqual(new Date('2026-11-08T17:30:00Z'));
  });

  test('shows at exactly the age limit and not past it', () => {
    expect(findInboxSession([marker('Start', '2026-11-08T12:00:00Z')], { now })).not.toBeNull();
    expect(findInboxSession([marker('Start', '2026-11-08T11:59:59Z')], { now })).toBeNull();
  });
});

describe('readInboxSession', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-session-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reads marker files and ignores everything else', async () => {
    fs.writeFileSync(path.join(dir, 'time-tracking-1-iPad.txt'), 'Start\n2026-11-08T12:32:42-05:00\nHosting\n');
    fs.writeFileSync(path.join(dir, 'time-tracking-2-iPad.txt'), 'garbage');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'Stop\n2026-11-08T12:50:00-05:00\nHosting\n');
    fs.writeFileSync(path.join(dir, 'time-tracking-3.pdf'), 'Stop\n2026-11-08T12:50:00-05:00\nHosting\n');

    expect(await readInboxSession(dir, { now })).toEqual({
      description: 'Hosting',
      startTime: new Date('2026-11-08T17:32:42Z')
    });
  });

  test('a trashed Start/Stop pair prevents an older inbox Start from returning', async () => {
    fs.writeFileSync(path.join(dir, 'time-tracking-a.txt'), 'Start\n2026-11-08T17:00:00Z\nReviews\n');
    const trashDir = path.join(dir, '.trash', '2026-11-08');
    fs.mkdirSync(trashDir, { recursive: true });
    fs.writeFileSync(path.join(trashDir, 'time-tracking-b-start.txt'), 'Start\n2026-11-08T17:30:00Z\nHosting\n');
    fs.writeFileSync(path.join(trashDir, 'time-tracking-b-stop.txt'), 'Stop\n2026-11-08T17:45:00Z\nHosting\n');

    expect(await readInboxSession(dir, { now })).toBeNull();
  });

  test('a missing inbox is no session', async () => {
    expect(await readInboxSession(path.join(dir, 'absent'), { now })).toBeNull();
  });
});
