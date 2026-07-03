import path from 'path';
import { normalizeUrlPath } from '../src/url-path.js';

describe('normalizeUrlPath', () => {
  test('normalizes leading slash in wildcard path', () => {
    expect(normalizeUrlPath('/notes/x.md')).toBe('notes/x.md');
  });

  test('normalizes repeated leading slashes', () => {
    expect(normalizeUrlPath('//notes/x.md')).toBe('notes/x.md');
  });

  test('normalizes path arrays from wildcard params', () => {
    expect(normalizeUrlPath(['notes', 'x.md'])).toBe('notes/x.md');
  });

  test('normalizes windows separators to URL slashes', () => {
    const winRelative = path.win32.relative('C:\\vault', 'C:\\vault\\notes\\x.md');
    expect(normalizeUrlPath(winRelative)).toBe('notes/x.md');
  });
});
