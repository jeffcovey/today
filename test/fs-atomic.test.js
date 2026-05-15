import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeFileAtomic } from '../src/fs-atomic.js';

describe('writeFileAtomic', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes content when the target does not exist and reports true', () => {
    const file = path.join(dir, 'plan.md');
    const wrote = writeFileAtomic(file, 'hello');
    expect(wrote).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('hello');
  });

  test('skips the write when content is byte-identical and reports false', () => {
    const file = path.join(dir, 'plan.md');
    writeFileAtomic(file, 'same');
    const mtimeBefore = fs.statSync(file).mtimeMs;

    const wrote = writeFileAtomic(file, 'same');

    expect(wrote).toBe(false);
    // Unchanged write must not touch the file at all (no mtime bump = no
    // file-sync churn).
    expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);
  });

  test('overwrites when content changed and reports true', () => {
    const file = path.join(dir, 'plan.md');
    writeFileAtomic(file, 'v1');
    const wrote = writeFileAtomic(file, 'v2');
    expect(wrote).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('v2');
  });

  test('creates missing parent directories', () => {
    const file = path.join(dir, 'nested', 'deep', 'plan.md');
    writeFileAtomic(file, 'x');
    expect(fs.readFileSync(file, 'utf-8')).toBe('x');
  });

  test('leaves no temp files behind on success', () => {
    const file = path.join(dir, 'plan.md');
    writeFileAtomic(file, 'a');
    writeFileAtomic(file, 'b');
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  test('preserves the original file when the write throws', () => {
    const file = path.join(dir, 'plan.md');
    writeFileAtomic(file, 'original');

    // Force fsync to throw mid-write; the original must survive intact and no
    // temp file may be left behind.
    const spy = jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => writeFileAtomic(file, 'replacement')).toThrow('disk full');
    spy.mockRestore();

    expect(fs.readFileSync(file, 'utf-8')).toBe('original');
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
