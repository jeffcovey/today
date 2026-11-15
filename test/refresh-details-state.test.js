// Ticking a task re-renders the page content; callouts the user had opened
// or closed must stay that way (issue #726).
import fs from 'fs';

const commonSource = fs.readFileSync(new URL('../src/web/public/js/common.js', import.meta.url), 'utf8');
const webServerSource = fs.readFileSync(new URL('../src/web-server.js', import.meta.url), 'utf8');

const helperSource = commonSource.slice(
  commonSource.indexOf('function detailsByKey'),
  commonSource.indexOf('// Task checkbox toggle')
);
const { captureDetailsState, restoreDetailsState } = new Function(
  `${helperSource}; return { captureDetailsState, restoreDetailsState };`
)();

function fakeRoot(callouts) {
  const details = callouts.map(([label, open]) => ({
    open,
    querySelector: () => (label === null ? null : { textContent: `\n${label}\n` })
  }));
  return { details, querySelectorAll: () => details };
}

describe('callout state across a content refresh', () => {
  test('reopens what the user opened and recloses what they closed', () => {
    const before = fakeRoot([['All tasks', true], ['📆 Upcoming', false], ['✅ Completed Today', false]]);
    // Fresh render: markdown defaults (first two folded, last open)
    const after = fakeRoot([['All tasks', false], ['📆 Upcoming', false], ['✅ Completed Today', true]]);
    restoreDetailsState(after, captureDetailsState(before));
    expect(after.details.map(d => d.open)).toEqual([true, false, false]);
  });

  test('tells apart callouts that share a title by their order', () => {
    const before = fakeRoot([['Note', false], ['Note', true]]);
    const after = fakeRoot([['Note', false], ['Note', false]]);
    restoreDetailsState(after, captureDetailsState(before));
    expect(after.details.map(d => d.open)).toEqual([false, true]);
  });

  test('leaves callouts that were not on the page before at their default', () => {
    const before = fakeRoot([['All tasks', true]]);
    const after = fakeRoot([['All tasks', false], ['New section', true], [null, false]]);
    restoreDetailsState(after, captureDetailsState(before));
    expect(after.details.map(d => d.open)).toEqual([true, true, false]);
  });

  test('refreshContentArea captures before the swap and restores right after', () => {
    const body = webServerSource.slice(webServerSource.indexOf('async function refreshContentArea'));
    const capture = body.indexOf('captureDetailsState(currentContent)');
    const swap = body.indexOf('currentContent.innerHTML = newContent.innerHTML');
    const restore = body.indexOf('restoreDetailsState(currentContent, detailsState)');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(swap);
    expect(restore).toBeGreaterThan(swap);
  });
});
