import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFileBasedUpdater } from '../src/auto-tagger.js';

describe('createFileBasedUpdater', () => {
  let root;
  const rel = 'vault/logs/time-tracking';
  const id = (file, line) => `markdown-time-tracking/local:${rel}/${file}:${line}`;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-tagger-'));
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('tags a pipe-delimited month-file entry', () => {
    const file = path.join(root, rel, '2026-09.md');
    fs.writeFileSync(file, 'a|b|First\n2026-09-20T11:00:00-04:00|2026-09-20T12:00:00-04:00|Review plan\n');
    const updater = createFileBasedUpdater(root);
    expect(updater.update(id('2026-09.md', 1), 'Review plan #topic/planning')).toBe(true);
    updater.flush();
    expect(fs.readFileSync(file, 'utf8').split('\n')[1])
      .toBe('2026-09-20T11:00:00-04:00|2026-09-20T12:00:00-04:00|Review plan #topic/planning');
  });

  // Regression: the running timer has no pipes, so it could never be tagged and
  // every time-logs sync re-asked the AI about it (seconds per sync).
  test('tags the running timer in current-timer.md', () => {
    const file = path.join(root, rel, 'current-timer.md');
    fs.writeFileSync(file, 'Review plan\n2026-09-20T14:00:46-04:00');
    const updater = createFileBasedUpdater(root);
    expect(updater.update(id('current-timer.md', 0), 'Review plan #topic/planning')).toBe(true);
    updater.flush();
    expect(fs.readFileSync(file, 'utf8')).toBe('Review plan #topic/planning\n2026-09-20T14:00:46-04:00');
  });

  test('leaves current-timer.md alone if the timer changed meanwhile', () => {
    const file = path.join(root, rel, 'current-timer.md');
    fs.writeFileSync(file, 'A different task\n2026-09-20T14:05:00-04:00');
    const updater = createFileBasedUpdater(root);
    expect(updater.update(id('current-timer.md', 0), 'Review plan #topic/planning')).toBe(false);
    updater.flush();
    expect(fs.readFileSync(file, 'utf8')).toBe('A different task\n2026-09-20T14:05:00-04:00');
  });

  test('leaves current-timer.md alone once the timer was stopped', () => {
    const file = path.join(root, rel, 'current-timer.md');
    fs.writeFileSync(file, '');
    const updater = createFileBasedUpdater(root);
    expect(updater.update(id('current-timer.md', 0), 'Review plan #topic/planning')).toBe(false);
  });
});
