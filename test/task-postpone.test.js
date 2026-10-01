import { isPostponable, postponeTaskLine } from '../src/task-postpone.js';

const TODAY = '2026-09-30';

describe('isPostponable', () => {
  test('open task with a scheduled date', () => {
    expect(isPostponable('- [ ] Task ⏳ 2026-09-30')).toBe(true);
  });

  test('open task with a due date', () => {
    expect(isPostponable('- [ ] Task 📅 2026-09-30')).toBe(true);
  });

  test('open task inside a callout', () => {
    expect(isPostponable('> - [ ] Task ⏳ 2026-09-30')).toBe(true);
  });

  test('open task with no scheduled or due date', () => {
    expect(isPostponable('- [ ] Task ➕ 2026-09-01')).toBe(false);
    expect(isPostponable('- [ ] Task 🛫 2026-09-01')).toBe(false);
  });

  test('completed and cancelled tasks', () => {
    expect(isPostponable('- [x] Task ⏳ 2026-09-30 ✅ 2026-09-30')).toBe(false);
    expect(isPostponable('- [-] Task ⏳ 2026-09-30')).toBe(false);
  });

  test('non-task lines', () => {
    expect(isPostponable('Meeting moved to 📅 2026-09-30')).toBe(false);
  });
});

describe('postponeTaskLine', () => {
  test('moves a scheduled date of today to tomorrow', () => {
    expect(postponeTaskLine('- [ ] Task ⏳ 2026-09-30', TODAY)).toEqual({
      line: '- [ ] Task ⏳ 2026-10-01',
      scheduledDate: '2026-10-01',
      dueDate: null
    });
  });

  test('moves a due date of today to tomorrow', () => {
    expect(postponeTaskLine('- [ ] Task 📅 2026-09-30', TODAY)).toEqual({
      line: '- [ ] Task 📅 2026-10-01',
      scheduledDate: null,
      dueDate: '2026-10-01'
    });
  });

  test('moves overdue dates to tomorrow, not to the day after the old date', () => {
    expect(postponeTaskLine('- [ ] Task ⏳ 2026-09-12', TODAY).line).toBe('- [ ] Task ⏳ 2026-10-01');
  });

  test('moves both dates when both are today or earlier', () => {
    expect(postponeTaskLine('- [ ] Task ⏳ 2026-09-28 📅 2026-09-30', TODAY)).toEqual({
      line: '- [ ] Task ⏳ 2026-10-01 📅 2026-10-01',
      scheduledDate: '2026-10-01',
      dueDate: '2026-10-01'
    });
  });

  test('leaves a future due date alone when the scheduled date is current', () => {
    expect(postponeTaskLine('- [ ] Task ⏳ 2026-09-30 📅 2026-10-15', TODAY)).toEqual({
      line: '- [ ] Task ⏳ 2026-10-01 📅 2026-10-15',
      scheduledDate: '2026-10-01',
      dueDate: '2026-10-15'
    });
  });

  test('leaves a future scheduled date alone when the due date is current', () => {
    expect(postponeTaskLine('- [ ] Task ⏳ 2026-10-15 📅 2026-09-29', TODAY).line)
      .toBe('- [ ] Task ⏳ 2026-10-15 📅 2026-10-01');
  });

  test('pushes a future scheduled date out one day', () => {
    expect(postponeTaskLine('- [ ] Task ⏳ 2026-10-10', TODAY).line).toBe('- [ ] Task ⏳ 2026-10-11');
  });

  test('pushes only the due date when both dates are in the future', () => {
    expect(postponeTaskLine('- [ ] Task ⏳ 2026-10-10 📅 2026-10-20', TODAY)).toEqual({
      line: '- [ ] Task ⏳ 2026-10-10 📅 2026-10-21',
      scheduledDate: '2026-10-10',
      dueDate: '2026-10-21'
    });
  });

  test('rolls over month and year boundaries', () => {
    expect(postponeTaskLine('- [ ] Task ⏳ 2026-12-31', '2026-12-31').line).toBe('- [ ] Task ⏳ 2027-01-01');
    expect(postponeTaskLine('- [ ] Task ⏳ 2028-02-28', '2028-02-28').line).toBe('- [ ] Task ⏳ 2028-02-29');
  });

  test('preserves everything else on the line', () => {
    const line = '  > - [ ] Pay rent 🔼 #topic/home 🔁 every month 🛫 2026-09-01 ⏳ 2026-09-30 📅 2026-09-30 ➕ 2026-08-01';
    expect(postponeTaskLine(line, TODAY).line)
      .toBe('  > - [ ] Pay rent 🔼 #topic/home 🔁 every month 🛫 2026-09-01 ⏳ 2026-10-01 📅 2026-10-01 ➕ 2026-08-01');
  });

  test('returns null for lines that are not postponable', () => {
    expect(postponeTaskLine('- [ ] Task with no dates', TODAY)).toBeNull();
    expect(postponeTaskLine('- [x] Done ⏳ 2026-09-30 ✅ 2026-09-30', TODAY)).toBeNull();
    expect(postponeTaskLine('Not a task ⏳ 2026-09-30', TODAY)).toBeNull();
  });
});
