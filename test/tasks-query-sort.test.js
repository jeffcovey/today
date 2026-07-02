import { parseSortLine, compareByDirective, sortTasks } from '../src/tasks-query-sort.js';

const d = (s) => new Date(s + 'T00:00:00');

// Minimal task factory — only the fields the comparator reads.
const task = (over = {}) => ({
  text: over.text ?? 'task',
  priority: over.priority ?? 0,
  createdDate: over.createdDate ?? null,
  dueDate: over.dueDate ?? null,
  scheduledDate: over.scheduledDate ?? null,
  doneDate: over.doneDate ?? null,
});

describe('parseSortLine', () => {
  test('parses a plain field directive', () => {
    expect(parseSortLine('sort by created')).toEqual({ type: 'field', field: 'created', reverse: false });
  });

  test('parses a reversed field directive', () => {
    expect(parseSortLine('sort by due reverse')).toEqual({ type: 'field', field: 'due', reverse: true });
  });

  test('parses a function directive', () => {
    expect(parseSortLine('sort by function task.priority')).toEqual({ type: 'function', expr: 'task.priority' });
  });

  test('returns null for an unrecognized line', () => {
    expect(parseSortLine('sort by')).toBeNull();
  });
});

describe('compareByDirective date fields', () => {
  for (const [field, prop] of [['created', 'createdDate'], ['due', 'dueDate'], ['scheduled', 'scheduledDate'], ['done', 'doneDate']]) {
    test(`sorts by ${field} ascending by default`, () => {
      const older = task({ [prop]: d('2026-01-01') });
      const newer = task({ [prop]: d('2026-06-01') });
      expect(compareByDirective(older, newer, { type: 'field', field, reverse: false })).toBeLessThan(0);
      expect(compareByDirective(newer, older, { type: 'field', field, reverse: false })).toBeGreaterThan(0);
    });

    test(`reverses ${field} when requested`, () => {
      const older = task({ [prop]: d('2026-01-01') });
      const newer = task({ [prop]: d('2026-06-01') });
      expect(compareByDirective(older, newer, { type: 'field', field, reverse: true })).toBeGreaterThan(0);
    });

    test(`treats a missing ${field} as epoch (sorts first ascending)`, () => {
      const none = task();
      const dated = task({ [prop]: d('2026-01-01') });
      expect(compareByDirective(none, dated, { type: 'field', field, reverse: false })).toBeLessThan(0);
    });
  }
});

describe('compareByDirective priority', () => {
  test('sorts higher priority first by default', () => {
    const high = task({ priority: 3 });
    const low = task({ priority: 1 });
    expect(compareByDirective(high, low, { type: 'field', field: 'priority', reverse: false })).toBeLessThan(0);
  });

  test('reverses to lower priority first', () => {
    const high = task({ priority: 3 });
    const low = task({ priority: 1 });
    expect(compareByDirective(high, low, { type: 'field', field: 'priority', reverse: true })).toBeGreaterThan(0);
  });
});

describe('compareByDirective function and unknown fields', () => {
  test('compares strings via localeCompare', () => {
    const a = task({ text: 'apple' });
    const b = task({ text: 'banana' });
    expect(compareByDirective(a, b, { type: 'function', expr: 'task.text' })).toBeLessThan(0);
  });

  test('compares numbers from a function', () => {
    const a = task({ priority: 1 });
    const b = task({ priority: 5 });
    expect(compareByDirective(a, b, { type: 'function', expr: 'task.priority' })).toBeLessThan(0);
  });

  test('a throwing function expression is a no-op (returns empty string)', () => {
    const a = task();
    const b = task();
    expect(compareByDirective(a, b, { type: 'function', expr: 'task.nope.boom' })).toBe(0);
  });

  test('an unknown field is a no-op rather than throwing', () => {
    const a = task({ createdDate: d('2026-01-01') });
    const b = task({ createdDate: d('2026-06-01') });
    expect(compareByDirective(a, b, { type: 'field', field: 'bogus', reverse: false })).toBe(0);
  });
});

describe('sortTasks', () => {
  test('orders by created date — the originally-broken case', () => {
    const tasks = [
      task({ text: 'b', createdDate: d('2026-03-01') }),
      task({ text: 'a', createdDate: d('2026-01-01') }),
      task({ text: 'c', createdDate: d('2026-06-01') }),
    ];
    sortTasks(tasks, [{ type: 'field', field: 'created', reverse: false }]);
    expect(tasks.map(t => t.text)).toEqual(['a', 'b', 'c']);
  });

  test('applies directives in precedence order (first = primary)', () => {
    const tasks = [
      task({ text: 'lowprio-early', priority: 1, createdDate: d('2026-01-01') }),
      task({ text: 'highprio-late', priority: 3, createdDate: d('2026-06-01') }),
      task({ text: 'highprio-early', priority: 3, createdDate: d('2026-01-01') }),
    ];
    sortTasks(tasks, [
      { type: 'field', field: 'priority', reverse: false },
      { type: 'field', field: 'created', reverse: false },
    ]);
    expect(tasks.map(t => t.text)).toEqual(['highprio-early', 'highprio-late', 'lowprio-early']);
  });

  test('is a stable no-op with no directives', () => {
    const tasks = [task({ text: 'x' }), task({ text: 'y' }), task({ text: 'z' })];
    sortTasks(tasks, []);
    expect(tasks.map(t => t.text)).toEqual(['x', 'y', 'z']);
  });
});
