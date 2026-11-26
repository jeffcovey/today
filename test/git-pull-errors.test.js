import { pullBlockedByLocalChanges, pathsBlockingPull, placeholderHint } from '../src/git-pull-errors.js';

// The error git printed for a blocked pull in the vault on 2026-11-24.
const BLOCKED = [
  'error: Your local changes to the following files would be overwritten by merge:',
  '\tdiary/2026-11-23.md',
  '\tgraphs/daylight.svg',
  '\tlogs/upcoming-events.json',
  'Please commit your changes or stash them before you merge.',
  'error: The following untracked working tree files would be overwritten by merge:',
  '\tinbox/.trash/2026-11-23/time-tracking-202611327-201166-iPad.txt',
  '\trecipes/Mushroom & Herb Shepherd’s Pie topped with Cheesy Mashed Potatoes.md',
  'Please move or remove them before you merge.',
  'Aborting',
  'Updating 78d4bba9a..3151e7ea3'
].join('\n');

describe('pullBlockedByLocalChanges', () => {
  test.each([
    BLOCKED,
    'error: The following untracked working tree files would be overwritten by merge:\n\tplans/new.md\nPlease move or remove them before you merge.',
    'error: cannot pull with rebase: You have unstaged changes.',
    'error: cannot pull with rebase: Your index contains uncommitted changes.'
  ])('stashing can help: %s', (stderr) => {
    expect(pullBlockedByLocalChanges(stderr)).toBe(true);
  });

  test.each([
    'Host key verification failed.\nfatal: Could not read from remote repository.',
    'ssh: Could not resolve hostname github.com: nodename nor servname provided',
    'git@github.com: Permission denied (publickey).',
    'fatal: Not possible to fast-forward, aborting.',
    '',
    undefined
  ])('stashing cannot help: %s', (stderr) => {
    expect(pullBlockedByLocalChanges(stderr)).toBe(false);
  });

  test('accepts a Buffer', () => {
    expect(pullBlockedByLocalChanges(Buffer.from('Please commit your changes or stash them before you merge.'))).toBe(true);
  });
});

describe('pathsBlockingPull', () => {
  test('separates changed and untracked files, including spaces and non-ASCII names', () => {
    expect(pathsBlockingPull(BLOCKED)).toEqual({
      changed: ['diary/2026-11-23.md', 'graphs/daylight.svg', 'logs/upcoming-events.json'],
      untracked: [
        'inbox/.trash/2026-11-23/time-tracking-202611327-201166-iPad.txt',
        'recipes/Mushroom & Herb Shepherd’s Pie topped with Cheesy Mashed Potatoes.md'
      ]
    });
  });

  test('returns nothing when git lists no files', () => {
    const none = { changed: [], untracked: [] };
    expect(pathsBlockingPull('error: cannot pull with rebase: You have unstaged changes.')).toEqual(none);
    expect(pathsBlockingPull(undefined)).toEqual(none);
  });
});

describe('placeholderHint', () => {
  test('explains crashes reading a file', () => {
    expect(placeholderHint('error: update-index died of signal 7\nCannot save the untracked files')).toMatch(/iCloud placeholder/);
    expect(placeholderHint('fatal: mmap failed: Operation timed out')).toMatch(/iCloud placeholder/);
  });

  test('stays quiet otherwise', () => {
    expect(placeholderHint('error: pathspec did not match')).toBe('');
  });
});

