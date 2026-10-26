/**
 * The three timer cards are built in three different places, and the code that
 * closes one on a press lives in the browser script. The data-timer-action
 * attribute is therefore a contract between two files that no single test
 * renders together, so these check both ends of it: that every control which
 * starts or stops a clock is marked, and that the script acts on the mark.
 */

import fs from 'fs';

const webServerSource = fs.readFileSync(new URL('../src/web-server.js', import.meta.url), 'utf8');
const commonSource = fs.readFileSync(new URL('../src/web/public/js/common.js', import.meta.url), 'utf8');

// A widget's source, from its declaration to the next top-level one. Column
// zero is the tell: everything inside the function is indented.
function widgetSource(name) {
  const start = webServerSource.search(new RegExp(`(async )?function ${name}\\(`));
  expect(start).toBeGreaterThan(-1);
  const body = webServerSource.slice(start);
  const next = body.slice(1).search(/\n(async function |function |const |\/\/ )/);
  return next > -1 ? body.slice(0, next + 1) : body;
}

const collapsingActions = () => {
  const match = commonSource.match(/const COLLAPSING_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  expect(match).not.toBeNull();
  return match[1].split(',').map((action) => action.trim().replace(/^'|'$/g, ''));
};

describe('which presses collapse a timer card', () => {
  test('starting and stopping do', () => {
    const actions = collapsingActions();
    expect(actions).toContain('start');
    expect(actions).toContain('stop');
    // Both of these start a clock that was not running: the next interval of a
    // pomodoro, and a paused timer picked back up.
    expect(actions).toContain('next');
    expect(actions).toContain('resume');
  });

  test('pausing and skipping do not', () => {
    const actions = collapsingActions();
    expect(actions).not.toContain('pause');
    expect(actions).not.toContain('skip');
  });

  test('the card is closed before the memory is written', () => {
    // Otherwise the memory records it open and the reload reopens it.
    const handler = commonSource.slice(commonSource.indexOf("card.addEventListener('click'"));
    const closed = handler.indexOf('card.open = false');
    const remembered = handler.indexOf('remember()');
    expect(closed).toBeGreaterThan(-1);
    expect(remembered).toBeGreaterThan(closed);
  });
});

describe('every control that starts or stops a clock is marked', () => {
  test('the focus timer', () => {
    const source = widgetSource('getTimerWidget');
    expect(source).toContain('data-timer-action="start"');
    expect(source).toContain('data-timer-action="stop"');
  });

  test('the task timer', () => {
    const source = widgetSource('getTaskTimerWidget');
    expect(source).toContain('data-timer-action="start"');
    expect(source).toContain('data-timer-action="stop"');
    expect(source).toContain('data-timer-action="resume"');
  });

  test('the pomodoro', () => {
    // Its idle card carries the attribute itself; every other control it
    // offers is built by pomodoroButton, which names the action it posts to.
    expect(widgetSource('getPomodoroWidget')).toContain('data-timer-action="start"');
    expect(widgetSource('pomodoroButton')).toContain('data-timer-action="${action}"');
  });
});
