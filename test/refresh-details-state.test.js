// Ticking a task re-renders the page content; callouts the user had opened
// or closed must stay that way (issue #726).
import fs from 'fs';

const commonSource = fs.readFileSync(new URL('../src/web/public/js/common.js', import.meta.url), 'utf8');
const webServerSource = fs.readFileSync(new URL('../src/web-server.js', import.meta.url), 'utf8');

const helperSource = commonSource.slice(
  commonSource.indexOf('function detailsByKey'),
  commonSource.indexOf('// Task checkbox toggle')
);
const {
  captureDetailsState,
  restoreDetailsState,
  deferredBlocksByKey,
  captureDeferredDetailsState,
  restoreDeferredDetailsState
} = new Function(
  `${helperSource}; return {
    captureDetailsState,
    restoreDetailsState,
    deferredBlocksByKey,
    captureDeferredDetailsState,
    restoreDeferredDetailsState
  };`
)();

const loaderStart = webServerSource.indexOf('function loadDeferredBlocks(root');
const loaderEnd = webServerSource.indexOf(
  "document.addEventListener('DOMContentLoaded', function() {\n          loadDeferredBlocks(document)",
  loaderStart
);
const loaderSource = webServerSource.slice(loaderStart, loaderEnd);

function fakeDetail(label, open, block = null) {
  return {
    open,
    querySelector: () => (label === null ? null : { textContent: `\n${label}\n` }),
    closest: () => block
  };
}

function fakeBlock(identity, callouts = []) {
  const block = {
    dataset: { deferredSrc: identity },
    details: [],
    querySelectorAll: selector => (selector === 'details' ? block.details : [])
  };
  block.details = callouts.map(([label, open]) => fakeDetail(label, open, block));
  Object.defineProperty(block, 'innerHTML', {
    set(html) {
      block.details = block.onInsert ? block.onInsert(html) : [];
    }
  });
  return block;
}

function fakeRoot(shellCallouts, deferred = [], deferredFirst = false) {
  const shellDetails = shellCallouts.map(([label, open]) => fakeDetail(label, open));
  const blocks = deferred.map(({ identity, callouts }) => fakeBlock(identity, callouts));
  const details = () => {
    const blockDetails = blocks.flatMap(block => block.details);
    return deferredFirst ? [...blockDetails, ...shellDetails] : [...shellDetails, ...blockDetails];
  };
  return {
    blocks,
    shellDetails,
    querySelectorAll: selector => {
      if (selector === 'details') return details();
      if (selector === '.deferred-block[data-deferred-src]') return blocks;
      return [];
    }
  };
}

function makeDeferredLoader(fetch) {
  return new Function(
    'fetch',
    'restoreDeferredDetailsState',
    'deferredBlocksByKey',
    'console',
    'location',
    `${loaderSource}; return loadDeferredBlocks;`
  )(fetch, restoreDeferredDetailsState, deferredBlocksByKey, console, {});
}

describe('callout state across a content refresh', () => {
  test('reopens what the user opened and recloses what they closed', () => {
    const before = fakeRoot([['All tasks', true], ['📆 Upcoming', false], ['✅ Completed Today', false]]);
    // Fresh render: markdown defaults (first two folded, last open)
    const after = fakeRoot([['All tasks', false], ['📆 Upcoming', false], ['✅ Completed Today', true]]);
    restoreDetailsState(after, captureDetailsState(before));
    expect(after.shellDetails.map(d => d.open)).toEqual([true, false, false]);
  });

  test('tells apart callouts that share a title by their order', () => {
    const before = fakeRoot([['Note', false], ['Note', true]]);
    const after = fakeRoot([['Note', false], ['Note', false]]);
    restoreDetailsState(after, captureDetailsState(before));
    expect(after.shellDetails.map(d => d.open)).toEqual([false, true]);
  });

  test('leaves callouts that were not on the page before at their default', () => {
    const before = fakeRoot([['All tasks', true]]);
    const after = fakeRoot([['All tasks', false], ['New section', true], [null, false]]);
    restoreDetailsState(after, captureDetailsState(before));
    expect(after.shellDetails.map(d => d.open)).toEqual([true, true, false]);
  });

  test('restores each deferred block after its content is inserted', async () => {
    const identities = [
      '/_block?path=page.md&id=first',
      '/_block?path=page.md&id=second'
    ];
    const before = fakeRoot([], [
      { identity: identities[0], callouts: [['Note', false]] },
      { identity: identities[1], callouts: [['Note', true]] }
    ]);
    const deferredState = captureDeferredDetailsState(before);
    const after = fakeRoot([], [
      { identity: identities[0], callouts: [] },
      { identity: identities[1], callouts: [] }
    ]);
    after.blocks[0].onInsert = () => [fakeDetail('Note', true, after.blocks[0])];
    after.blocks[1].onInsert = () => [fakeDetail('Note', false, after.blocks[1])];

    await makeDeferredLoader(
      async () => ({ redirected: false, text: async () => '<details>Note</details>' })
    )(after, deferredState);

    expect(after.blocks.map(block => block.details[0].open)).toEqual([false, true]);
  });

  test('a deferred Note does not shift the key for a user-opened shell Note', () => {
    const before = fakeRoot(
      [['Note', true]],
      [{ identity: '/_block?path=page.md&id=abc123', callouts: [['Note', false]] }],
      true
    );
    const after = fakeRoot(
      [['Note', false]],
      [{ identity: '/_block?path=page.md&id=abc123', callouts: [] }]
    );

    restoreDetailsState(after, captureDetailsState(before));
    expect(after.shellDetails[0].open).toBe(true);
  });

  test('refreshContentArea captures state before swapping and loads deferred state after insertion', () => {
    const body = webServerSource.slice(webServerSource.indexOf('async function refreshContentArea'));
    const capture = body.indexOf('captureDetailsState(currentContent)');
    const swap = body.indexOf('currentContent.innerHTML = newContent.innerHTML');
    const restore = body.indexOf('restoreDetailsState(currentContent, detailsState)');
    const load = body.indexOf('loadDeferredBlocks(currentContent, deferredDetailsState)');
    const insert = loaderSource.indexOf('block.innerHTML = await response.text()');
    const restoreBlock = loaderSource.indexOf('restoreDeferredDetailsState(block, deferredDetailsState.get(key))');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(swap);
    expect(restore).toBeGreaterThan(swap);
    expect(body.indexOf('captureDeferredDetailsState(currentContent)')).toBeLessThan(swap);
    expect(load).toBeGreaterThan(restore);
    expect(insert).toBeGreaterThan(-1);
    expect(restoreBlock).toBeGreaterThan(insert);
  });
});
