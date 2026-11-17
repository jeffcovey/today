import { enableTaskCheckboxes, isCancelledTaskLine, markTaskListItems } from '../src/task-checkboxes.js';

describe('markTaskListItems', () => {
  test('marks the canceled task\'s own list item, not a plain bullet above it (issue #735)', () => {
    const html = [
      '<ul>',
      '<li><strong>W47:</strong> 0/3 sessions done</li>',
      '<li>Plain note</li>',
      '</ul>',
      '<ul>',
      '<li><input type="checkbox" class="task-checkbox task-cancelled" data-file="plans/p.md" data-line="175"> Thanksgiving dinner</li>',
      '</ul>'
    ].join('\n');

    const out = markTaskListItems(html);

    expect(out).toContain('<li><strong>W47:</strong> 0/3 sessions done</li>');
    expect(out).toContain('<li>Plain note</li>');
    expect(out).toContain('<li data-file="plans/p.md" data-line="175" class="task-cancelled"><input');
  });

  test('marks open tasks with their file and line but no canceled class', () => {
    const out = markTaskListItems('<li>Note</li>\n<li><input type="checkbox" class="task-checkbox" data-file="a.md" data-line="3"> Open</li>');
    expect(out).toBe('<li>Note</li>\n<li data-file="a.md" data-line="3"><input type="checkbox" class="task-checkbox" data-file="a.md" data-line="3"> Open</li>');
  });

  test('still finds a checkbox wrapped in a paragraph inside its list item', () => {
    const out = markTaskListItems('<li><p><input type="checkbox" class="task-checkbox task-cancelled" data-file="a.md" data-line="9"> Loose item</p></li>');
    expect(out).toMatch(/^<li data-file="a.md" data-line="9" class="task-cancelled"><p><input/);
  });
});

describe('enableTaskCheckboxes', () => {
  test('enables open and done checkboxes that marked rendered disabled', () => {
    expect(enableTaskCheckboxes('<input disabled="" type="checkbox" class="task-checkbox">'))
      .toBe('<input type="checkbox" class="task-checkbox">');
    expect(enableTaskCheckboxes('<input checked="" disabled="" type="checkbox">'))
      .toBe('<input checked="" type="checkbox">');
  });

  test('keeps canceled checkboxes disabled so they cannot be clicked (issue #735)', () => {
    const out = enableTaskCheckboxes('<input type="checkbox" class="task-checkbox task-cancelled" data-file="a.md" data-line="2">');
    expect(out).toBe('<input disabled title="Cancelled" type="checkbox" class="task-checkbox task-cancelled" data-file="a.md" data-line="2">');
  });

  test('does not add a second disabled to a canceled checkbox marked already rendered disabled', () => {
    const out = enableTaskCheckboxes('<input disabled="" type="checkbox" class="task-checkbox task-cancelled">');
    expect(out.match(/disabled/g)).toHaveLength(1);
  });

  test('leaves data attributes that contain the word disabled alone', () => {
    expect(enableTaskCheckboxes('<input type="checkbox" data-disabled="x">'))
      .toBe('<input type="checkbox" data-disabled="x">');
  });
});

describe('isCancelledTaskLine', () => {
  test('recognises canceled tasks, including in callouts', () => {
    expect(isCancelledTaskLine('- [-] Skipped')).toBe(true);
    expect(isCancelledTaskLine('> - [-] → Jeff: go or skip?')).toBe(true);
    expect(isCancelledTaskLine('  - [-] Nested')).toBe(true);
  });

  test('rejects open and done tasks', () => {
    expect(isCancelledTaskLine('- [ ] Open')).toBe(false);
    expect(isCancelledTaskLine('- [x] Done')).toBe(false);
    expect(isCancelledTaskLine('Text with - [-] inside')).toBe(false);
  });
});
