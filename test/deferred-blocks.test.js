import { DeferredBlockRegistry, deferredBlockId, deferredBlockPlaceholder } from '../src/deferred-blocks.js';
import { containsDynamicContent } from '../src/dynamic-content.js';

describe('deferred blocks', () => {
  test('ids are stable per block source and kind', () => {
    expect(deferredBlockId('tasks', 'not done')).toBe(deferredBlockId('tasks', 'not done'));
    expect(deferredBlockId('tasks', 'not done')).not.toBe(deferredBlockId('tasks', 'done'));
    expect(deferredBlockId('tasks', 'x')).not.toBe(deferredBlockId('markdown', 'x'));
    expect(deferredBlockId('tasks', 'not done')).toMatch(/^[0-9a-f]{16}$/);
  });

  test('registry returns blocks by page and id', () => {
    const registry = new DeferredBlockRegistry();
    const id = registry.register('diary/today.md', '/vault/diary/today.md', 'tasks', 'not done', 123);
    expect(registry.get('diary/today.md', id)).toEqual({
      urlPath: 'diary/today.md', filePath: '/vault/diary/today.md', kind: 'tasks', source: 'not done', mtime: 123
    });
    // ids are scoped to the page
    expect(registry.get('diary/other.md', id)).toBeNull();
    expect(registry.get('diary/today.md', 'nope')).toBeNull();
  });

  test('registry invalidates all entries for a page', () => {
    const registry = new DeferredBlockRegistry();
    const first = registry.register('diary/today.md', '/vault/diary/today.md', 'tasks', 'first', 123);
    const second = registry.register('diary/today.md', '/vault/diary/today.md', 'markdown', 'second', 123);
    const other = registry.register('diary/other.md', '/vault/diary/other.md', 'tasks', 'other', 123);

    registry.invalidatePage('diary/today.md');

    expect(registry.get('diary/today.md', first)).toBeNull();
    expect(registry.get('diary/today.md', second)).toBeNull();
    expect(registry.get('diary/other.md', other)).not.toBeNull();
  });

  test('registry evicts the least recently registered entries', () => {
    const registry = new DeferredBlockRegistry(2);
    const a = registry.register('p', 'f', 'tasks', 'a', 1);
    const b = registry.register('p', 'f', 'tasks', 'b', 1);
    registry.register('p', 'f', 'tasks', 'a', 1); // refresh a
    const c = registry.register('p', 'f', 'tasks', 'c', 1);
    expect(registry.get('p', a)).not.toBeNull();
    expect(registry.get('p', b)).toBeNull();
    expect(registry.get('p', c)).not.toBeNull();
  });

  test('placeholder is one line, encodes the page path, and is not dynamic content', () => {
    const html = deferredBlockPlaceholder('plans/2026 Q4#notes.md', 'abc123');
    expect(html).not.toContain('\n');
    expect(html).toContain('data-deferred-src="/_block?path=plans%2F2026%20Q4%23notes.md&amp;id=abc123"');
    // The page shell must stay disk-cacheable
    expect(containsDynamicContent(html)).toBe(false);
  });
});
