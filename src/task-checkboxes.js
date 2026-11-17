/**
 * Post-processing for task checkboxes in rendered Markdown pages.
 *
 * Kept out of the web server so the rules can be unit-tested. Canceled tasks
 * ("- [-]") render as an unchecked checkbox marked task-cancelled; these
 * helpers keep that mark on the right list item and keep the checkbox from
 * being clicked, since /task/toggle can only check or uncheck (issue #735).
 */

const CANCELLED_TASK_LINE = /^(?:\s*>)*\s*- \[-\]/;

/**
 * True when a Markdown line is a canceled task ("- [-] ..."), including one
 * inside a blockquote or callout.
 */
export function isCancelledTaskLine(line) {
  return CANCELLED_TASK_LINE.test(line);
}

/**
 * Copy each task checkbox's data-file and data-line onto its own <li>, and
 * mark that <li> task-cancelled when the checkbox is.
 *
 * The <li> is the nearest one before the checkbox: the text between them may
 * not open or close another list item. Without that limit the match ran from
 * the first plain bullet above a task down to the task's checkbox, so a
 * canceled task's styling landed on an unrelated bullet and the task itself
 * looked open.
 */
export function markTaskListItems(html) {
  return html.replace(
    /<li>((?:(?!<\/?li\b)[\s\S])*?)<input([^>]*data-file="([^"]+)"[^>]*data-line="(\d+)"[^>]*)>/gi,
    (match, before, checkboxAttrs, file, line) => {
      const liClass = /\btask-cancelled\b/.test(checkboxAttrs) ? ' class="task-cancelled"' : '';
      return `<li data-file="${file}" data-line="${line}"${liClass}>${before}<input${checkboxAttrs}>`;
    }
  );
}

/**
 * Marked renders task checkboxes disabled. Enable them so they can be
 * toggled, except canceled ones, which stay disabled: there is no toggle for
 * a canceled task, and a click on one used to end in "Failed to update task".
 */
export function enableTaskCheckboxes(html) {
  return html.replace(/<input[^>]*type="checkbox"[^>]*>/gi, (match) => {
    const enabled = match.replace(/\s+disabled(?:="[^"]*")?(?=[\s/>])/gi, '');
    if (!/class="[^"]*\btask-cancelled\b/.test(enabled)) {
      return enabled;
    }
    return enabled.replace(/^<input/i, '<input disabled title="Cancelled"');
  });
}
