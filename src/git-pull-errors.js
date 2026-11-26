// Git's messages when a pull is blocked by local changes: the only kind of
// pull failure that stashing the changes can fix.
const LOCAL_CHANGES_BLOCK_PULL = [
  /local changes to the following files would be overwritten/i,
  /untracked working tree files would be overwritten/i,
  /commit your changes or stash them/i,
  /you have unstaged changes/i,
  /your index contains uncommitted changes/i
];

/**
 * True when a failed `git pull`'s stderr says local changes are in the way.
 * Other failures (network, SSH, authentication, a diverged branch) aren't
 * helped by stashing.
 */
export function pullBlockedByLocalChanges(stderr) {
  const text = String(stderr || '');
  return LOCAL_CHANGES_BLOCK_PULL.some(pattern => pattern.test(text));
}

/**
 * The files git names as being in the way of a pull, from its
 * "...would be overwritten by merge:" lists (one tab-indented path per line):
 * `changed` (local edits to tracked files) and `untracked` (local files the
 * pull would add). Both are empty when git didn't list any (e.g. "cannot
 * pull with rebase: You have unstaged changes"). Run the pull with
 * core.quotePath=false so non-ASCII names arrive unquoted.
 */
export function pathsBlockingPull(stderr) {
  const result = { changed: [], untracked: [] };
  let list = null;
  for (const line of String(stderr || '').split('\n')) {
    if (/would be overwritten by (merge|checkout)/i.test(line)) {
      list = /untracked/i.test(line) ? result.untracked : result.changed;
    } else if (list && line.startsWith('\t')) {
      const p = line.slice(1).trimEnd();
      if (p && !list.includes(p)) list.push(p);
    } else {
      list = null;
    }
  }
  return result;
}

/**
 * A note to add when a git command crashed reading a file, which in an
 * iCloud vault usually means a cloud-only placeholder whose contents
 * haven't downloaded (seen as "died of signal 7" or an mmap failure).
 */
export function placeholderHint(stderr) {
  const text = String(stderr || '');
  return /signal 7|signal 10|mmap failed|bus error/i.test(text)
    ? 'Git crashed reading a file. One of the files above may be an iCloud placeholder whose contents have not downloaded yet; wait for iCloud and try again.'
    : '';
}
