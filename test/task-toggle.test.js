/**
 * Tests for src/task-toggle.js: checking and unchecking task lines and
 * making the next occurrence of a 🔁 recurring task, without making a second
 * one (issue #688).
 */

import { jest } from '@jest/globals';
import {
  calculateNextRecurrence,
  getRecurrenceRule,
  taskIdentity,
  toggleTaskInLines,
} from '../src/task-toggle.js';

const TODAY = '2026-09-20';

const DONALD_OPEN = '- [ ] Contact Donald Schmoll #stage/off-stage #topic/friends_socializing 🔽 🔁 every 6 weeks when done ➕ 2026-01-06 ⏳ 2026-09-19';

describe('toggleTaskInLines', () => {
  test('completing a recurring task checks it and adds one next occurrence below it', () => {
    const lines = ['# Contacts', DONALD_OPEN, ''];
    const result = toggleTaskInLines(lines, 2, true, TODAY);

    expect(result.changed).toBe(true);
    expect(result.updatedLine).toBe(
      '- [x] Contact Donald Schmoll #stage/off-stage #topic/friends_socializing 🔽 🔁 every 6 weeks when done ➕ 2026-01-06 ⏳ 2026-09-19 ✅ 2026-09-20'
    );
    expect(result.newTaskLine).toBe(
      '- [ ] Contact Donald Schmoll #stage/off-stage #topic/friends_socializing 🔽 🔁 every 6 weeks when done ➕ 2026-01-06 ⏳ 2026-11-01'
    );
    expect(result.lines).toEqual(['# Contacts', result.updatedLine, result.newTaskLine, '']);
  });

  test('completing the same line twice does not add a second next occurrence', () => {
    const first = toggleTaskInLines(['# Contacts', DONALD_OPEN], 2, true, TODAY);
    // A second request for the same line number (double tap, another tab, a
    // stale page) now lands on the checked line.
    const second = toggleTaskInLines(first.lines, 2, true, TODAY);

    expect(second.changed).toBe(false);
    expect(second.newTaskLine).toBeNull();
    expect(second.lines).toEqual(first.lines);
    expect(second.lines.filter(l => l.startsWith('- [ ]'))).toHaveLength(1);
  });

  test('unchecking an open task changes nothing', () => {
    const result = toggleTaskInLines([DONALD_OPEN], 1, false, TODAY);
    expect(result.changed).toBe(false);
    expect(result.lines).toEqual([DONALD_OPEN]);
  });

  test('no new occurrence when an open copy of the task is already in the file', () => {
    // Two parallel chains of the same task, fields in a different order.
    const otherChain = '- [ ] Contact Donald Schmoll ➕ 2026-01-06 #stage/off-stage #topic/friends_socializing 🔽 🔁 every 6 weeks when done ⏳ 2026-09-25';
    const lines = [otherChain, DONALD_OPEN];
    const result = toggleTaskInLines(lines, 2, true, TODAY);

    expect(result.changed).toBe(true);
    expect(result.updatedLine).toMatch(/^- \[x\] .*✅ 2026-09-20$/);
    expect(result.newTaskLine).toBeNull();
    expect(result.lines).toEqual([otherChain, result.updatedLine]);
  });

  test('a task whose words are a reordering of another still gets its next occurrence', () => {
    const other = '- [ ] Ask Bob about Alice 🔁 every week ⏳ 2026-09-25';
    const result = toggleTaskInLines([other, '- [ ] Ask Alice about Bob 🔁 every week ⏳ 2026-09-20'], 2, true, TODAY);
    expect(result.newTaskLine).toBe('- [ ] Ask Alice about Bob 🔁 every week ⏳ 2026-09-27 ➕ 2026-09-20');
  });

  test('a different task with the same rule still gets its next occurrence', () => {
    const ken = '- [ ] Contact Ken Felts #stage/off-stage #topic/friends_socializing 🔽 🔁 every 6 weeks when done ⏳ 2026-12-11';
    const result = toggleTaskInLines([ken, DONALD_OPEN], 2, true, TODAY);
    expect(result.newTaskLine).toMatch(/Donald Schmoll.*⏳ 2026-11-01$/);
  });

  test('a trailing space on the open line does not leave double spaces or a trailing space', () => {
    const result = toggleTaskInLines([`${DONALD_OPEN} `], 1, true, TODAY);
    expect(result.updatedLine).not.toMatch(/ {2}/);
    expect(result.updatedLine).toMatch(/⏳ 2026-09-19 ✅ 2026-09-20$/);
    expect(result.newTaskLine).toMatch(/⏳ 2026-11-01$/);
  });

  test('a when-done task with a due date gets its due date advanced', () => {
    const line = '- [ ] Water plants 🔁 every 3 days when done 📅 2026-09-18';
    const result = toggleTaskInLines([line], 1, true, TODAY);
    expect(result.newTaskLine).toBe('- [ ] Water plants 🔁 every 3 days when done ⏳ 2026-09-23 📅 2026-09-23 ➕ 2026-09-20');
  });

  test('a task inside a blockquote keeps its prefix', () => {
    const line = '> - [ ] Stretch 🔁 every day ⏳ 2026-09-20';
    const result = toggleTaskInLines([line], 1, true, TODAY);
    expect(result.updatedLine).toBe('> - [x] Stretch 🔁 every day ⏳ 2026-09-20 ✅ 2026-09-20');
    expect(result.newTaskLine).toBe('> - [ ] Stretch 🔁 every day ⏳ 2026-09-21 ➕ 2026-09-20');
  });

  test('completing a task that does not recur adds nothing', () => {
    const result = toggleTaskInLines(['- [ ] Buy milk'], 1, true, TODAY);
    expect(result.updatedLine).toBe('- [x] Buy milk ✅ 2026-09-20');
    expect(result.newTaskLine).toBeNull();
    expect(result.lines).toHaveLength(1);
  });

  test('unchecking removes the completion date and adds nothing', () => {
    const result = toggleTaskInLines(['- [X] Buy milk ✅ 2026-09-19'], 1, false, TODAY);
    expect(result.updatedLine).toBe('- [ ] Buy milk');
    expect(result.lines).toEqual(['- [ ] Buy milk']);
  });

  test('reports a missing line or a line that is not a task', () => {
    expect(toggleTaskInLines(['text'], 3, true, TODAY).error).toBe('Task line not found');
    expect(toggleTaskInLines(['text'], 1, true, TODAY).error).toBe('Not a task line');
  });

  test('does not change the lines array it was given', () => {
    const lines = [DONALD_OPEN];
    toggleTaskInLines(lines, 1, true, TODAY);
    expect(lines).toEqual([DONALD_OPEN]);
  });
});

describe('taskIdentity', () => {
  test('ignores the checkbox, dates, field order and spacing', () => {
    const a = '- [x] Contact Paul Melville #stage/off-stage #topic/friends_socializing 🔽 🔁 every 6 weeks when done ➕ 2026-01-20 ⏳ 2026-03-03 ✅ 2026-02-06';
    const b = '- [ ] Contact Paul Melville 🔽 ⏳ 2026-12-08 #stage/off-stage  #topic/friends_socializing 🔁 every 6 weeks when done ➕ 2026-07-22 ';
    expect(taskIdentity(a)).toBe(taskIdentity(b));
  });

  test('keeps the description in order', () => {
    expect(taskIdentity('- [ ] Ask Alice about Bob 🔁 every week')).not.toBe(taskIdentity('- [ ] Ask Bob about Alice 🔁 every week'));
  });

  test('tells different rules apart', () => {
    expect(taskIdentity('- [ ] Call Sam 🔁 every week')).not.toBe(taskIdentity('- [ ] Call Sam 🔁 every 2 weeks'));
  });
});

describe('getRecurrenceRule', () => {
  test('stops at the next date or tag', () => {
    expect(getRecurrenceRule(DONALD_OPEN)).toBe('every 6 weeks when done');
    expect(getRecurrenceRule('- [ ] A 🔁 every week #tag')).toBe('every week');
    expect(getRecurrenceRule('- [ ] A')).toBeNull();
  });
});

describe('calculateNextRecurrence', () => {
  test('counts weeks, days, months and years from the given date', () => {
    expect(calculateNextRecurrence('every 6 weeks when done', '2026-09-20')).toBe('2026-11-01');
    expect(calculateNextRecurrence('every day', '2026-12-31')).toBe('2027-01-01');
    expect(calculateNextRecurrence('every month', '2026-01-15')).toBe('2026-02-15');
    expect(calculateNextRecurrence('every 2 years', '2026-03-01')).toBe('2028-03-01');
  });

  test('returns null for a rule it cannot read', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(calculateNextRecurrence('every weekday', '2026-09-20')).toBeNull();
    spy.mockRestore();
  });
});
