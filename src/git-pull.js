// The Git page's Pull: `git pull`, and when local changes are in the way,
// move just those aside, pull, and put them back.
//
// Only the files git names are touched, so nothing else in the vault is read
// or moved (in an iCloud vault, a cloud-only placeholder elsewhere would
// crash a full `git stash --include-untracked`).
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pullBlockedByLocalChanges, pathsBlockingPull, placeholderHint } from './git-pull-errors.js';

// Unquoted names in git's messages, so pathsBlockingPull() gets real paths.
const PULL = ['-c', 'core.quotePath=false', 'pull'];

/**
 * Pull into the repository at `repoPath`.
 * Returns { status, body }: status 200 with { ok, stashed?, resolved?, setAside? },
 * or 500 with { error, setAside? }.
 * `gitBinary` lets tests substitute a git that fails on cue.
 */
export function pullVault(repoPath, { gitBinary = 'git' } = {}) {
  const git = (args, timeout = 30000) => execFileSync(gitBinary, args, {
    cwd: repoPath, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024
  });
  // File contents as raw bytes, so non-UTF-8 and binary files aren't mangled.
  const gitBytes = (args) => execFileSync(gitBinary, args, {
    cwd: repoPath, timeout: 30000, maxBuffer: 100 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  });

  let pullErr;
  try {
    git(PULL);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    pullErr = err;
  }

  // Anything else (network, SSH, authentication, a diverged branch) won't be
  // fixed by moving local changes, so report it without touching the vault.
  if (!pullBlockedByLocalChanges(pullErr.stderr)) {
    return { status: 500, body: { error: String(pullErr.stderr || '') || 'Failed to pull' } };
  }

  const { changed, untracked } = pathsBlockingPull(pullErr.stderr);
  const listed = changed.length + untracked.length > 0;
  const setAside = [];
  // Identical local copies removed so the pull can bring them back:
  // { file, blob, mode }, so they can be rewritten if the pull fails.
  const removed = [];
  // Different local copies renamed to "<name>.local-<time>": { file, aside }.
  const movedAside = [];

  // When the pull didn't happen, put the untracked files back where they
  // were. A renamed file that can't go back stays aside and is reported in
  // setAside; a removed one that can't be rewritten is named in the
  // returned note (its contents are the upstream version).
  const restoreUntracked = () => {
    const notRestored = [];
    for (const { file, blob, mode } of removed) {
      const target = path.join(repoPath, file);
      try {
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, gitBytes(['cat-file', 'blob', blob]));
          fs.chmodSync(target, mode);
        }
      } catch (e) {
        console.error('Could not restore ' + file + ':', e.message);
        notRestored.push(file);
      }
    }
    removed.length = 0;
    for (const { file, aside } of [...movedAside]) {
      const target = path.join(repoPath, file);
      try {
        if (!fs.existsSync(target)) {
          fs.renameSync(path.join(repoPath, aside), target);
          setAside.splice(setAside.indexOf(aside), 1);
        }
      } catch (e) {
        console.error('Could not restore ' + file + ':', e.message);
      }
    }
    movedAside.length = 0;
    return notRestored.length
      ? `\n\nThese local files matched the incoming versions and were removed, but could not be put back (their contents are on the upstream branch):\n${notRestored.join('\n')}`
      : '';
  };

  // Untracked files the pull would add can't go through the stash: `stash
  // pop` refuses to restore them once the pull has created them, and then
  // skips the stashed edits too. If the local copy matches what's arriving
  // (common when iCloud or Unison already delivered it), remove it and let
  // the pull bring it back; otherwise keep it as "<name>.local-<time>".
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const file of untracked) {
      let incoming = '';
      try { incoming = git(['rev-parse', '@{upstream}:' + file]).trim(); } catch {}
      const local = git(['hash-object', '--', file]).trim();
      if (incoming && incoming === local) {
        const { mode } = fs.statSync(path.join(repoPath, file));
        fs.rmSync(path.join(repoPath, file));
        removed.push({ file, blob: incoming, mode });
      } else {
        const aside = `${file}.local-${stamp}`;
        fs.renameSync(path.join(repoPath, file), path.join(repoPath, aside));
        setAside.push(aside);
        movedAside.push({ file, aside });
      }
    }
  } catch (prepErr) {
    const note = restoreUntracked();
    const why = String(prepErr.stderr || '').trim() || prepErr.message || 'unknown error';
    const hint = placeholderHint(why);
    return { status: 500, body: { error: `Pull was blocked by local files, and setting them aside failed:\n${why}${hint ? '\n\n' + hint : ''}${note}`, setAside } };
  }

  if (listed && changed.length === 0) {
    // Only untracked files were in the way, and they're handled.
    try {
      git(PULL);
      return { status: 200, body: { ok: true, setAside } };
    } catch (retryErr) {
      const note = restoreUntracked();
      return { status: 500, body: { error: (String(retryErr.stderr || '') || 'Pull failed') + note, setAside } };
    }
  }

  const stashArgs = listed
    ? ['--literal-pathspecs', 'stash', 'push', '-m', 'Today: pull', '--', ...changed]
    : ['stash', 'push', '--include-untracked', '-m', 'Today: pull'];
  try {
    git(stashArgs);
  } catch (stashErr) {
    const note = restoreUntracked();
    const why = String(stashErr.stderr || '').trim() || stashErr.message || 'unknown error';
    const hint = placeholderHint(why);
    return { status: 500, body: { error: `Pull was blocked by local changes, and stashing them failed:\n${why}${hint ? '\n\n' + hint : ''}\n\nOriginal pull error:\n${pullErr.stderr || ''}${note}`, setAside } };
  }

  try {
    git(PULL);
  } catch (retryErr) {
    // Pull still failed after the stash: put the changes back and report.
    try { git(['stash', 'pop']); } catch {}
    const note = restoreUntracked();
    return { status: 500, body: { error: (String(retryErr.stderr || '') || 'Pull failed even after stashing changes') + note, setAside } };
  }

  const resolved = [];
  try {
    git(['stash', 'pop']);
  } catch (popErr) {
    // Conflicts between the pulled and stashed versions: resolve each with a
    // union merge (keep both sides' lines).
    let conflicted = [];
    // NUL-delimited, so names come back exactly (no quoting of non-ASCII
    // characters, no trimming).
    try { conflicted = git(['diff', '--name-only', '-z', '--diff-filter=U']).split('\0').filter(Boolean); } catch {}
    if (conflicted.length) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-union-'));
      for (const file of conflicted) {
        try {
          // Stage 1 = base, 2 = ours (pulled), 3 = theirs (stashed).
          const base = path.join(tmpDir, 'base');
          const ours = path.join(tmpDir, 'ours');
          const theirs = path.join(tmpDir, 'theirs');
          try { fs.writeFileSync(base, gitBytes(['show', ':1:' + file])); }
          catch { fs.writeFileSync(base, ''); } // no base = new file on one side
          fs.writeFileSync(ours, gitBytes(['show', ':2:' + file]));
          fs.writeFileSync(theirs, gitBytes(['show', ':3:' + file]));
          // merge-file writes into the first file; --union keeps both sides.
          // If it fails (a binary file, say), the error goes to the catch
          // below: the file stays unresolved and the stash is kept.
          execFileSync(gitBinary, ['merge-file', '--union', ours, base, theirs], { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          fs.copyFileSync(ours, path.join(repoPath, file));
          git(['add', '--', file]);
          resolved.push(file);
        } catch (e) {
          console.error('Union merge failed for ' + file + ':', e.message);
        }
      }
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
    const unresolved = conflicted.filter(f => !resolved.includes(f));
    if (conflicted.length === 0 || unresolved.length > 0) {
      // Not a conflict we could resolve: say so, and leave the stash in place
      // so nothing is lost.
      const why = String(popErr.stderr || '').trim() || popErr.message;
      return { status: 500, body: { error: `Pulled, but re-applying your local changes failed. They are kept in the git stash ("Today: pull"); restore them with git stash pop.\n${unresolved.length ? '\nUnresolved: ' + unresolved.join(', ') + '\n' : ''}\n${why}`, setAside } };
    }
    // All resolved: the stash entry is no longer needed, and the resolved
    // files go back to being ordinary local changes.
    try { git(['stash', 'drop']); } catch {}
    try { git(['--literal-pathspecs', 'reset', '-q', '--', ...resolved]); } catch {}
  }
  return { status: 200, body: { ok: true, stashed: true, resolved, setAside } };
}
