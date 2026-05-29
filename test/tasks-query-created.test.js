import { parseCreatedAfterDate, sortCreatedGroups } from '../src/tasks-query-created.js';

describe('tasks created-query helpers', () => {
  test('parses relative created-after filters', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    expect(parseCreatedAfterDate('created after 3 months ago', 'UTC', now)).toBe('2026-02-28');
    expect(parseCreatedAfterDate('created after 2 weeks ago', 'UTC', now)).toBe('2026-05-14');
  });

  test('parses absolute created-after filters', () => {
    expect(parseCreatedAfterDate('created after 2026-01-15', 'UTC')).toBe('2026-01-15');
  });

  test('returns null for unrelated filters', () => {
    expect(parseCreatedAfterDate('not done', 'UTC')).toBeNull();
  });

  test('sorts created groups with no-date last', () => {
    const groups = [['2026-01-01', []], ['No date', []], ['2026-03-01', []]];
    expect(sortCreatedGroups([...groups], false).map(([k]) => k)).toEqual(['2026-01-01', '2026-03-01', 'No date']);
    expect(sortCreatedGroups([...groups], true).map(([k]) => k)).toEqual(['2026-03-01', '2026-01-01', 'No date']);
  });
});
