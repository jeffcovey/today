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
 */
export function pullVault(repoPath) {
  const git = (args, timeout = 30000) => execFileSync('git', args, {
    cwd: repoPath, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024
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
        fs.rmSync(path.join(repoPath, file));
      } else {
        const aside = `${file}.local-${stamp}`;
        fs.renameSync(path.join(repoPath, file), path.join(repoPath, aside));
        setAside.push(aside);
      }
    }
  } catch (prepErr) {
    const why = String(prepErr.stderr || '').trim() || prepErr.message || 'unknown error';
    const hint = placeholderHint(why);
    return { status: 500, body: { error: `Pull was blocked by local files, and setting them aside failed:\n${why}${hint ? '\n\n' + hint : ''}`, setAside } };
  }

  if (listed && changed.length === 0) {
    // Only untracked files were in the way, and they're handled.
    try {
      git(PULL);
      return { status: 200, body: { ok: true, setAside } };
    } catch (retryErr) {
      return { status: 500, body: { error: String(retryErr.stderr || '') || 'Pull failed', setAside } };
    }
  }

  const stashArgs = listed
    ? ['--literal-pathspecs', 'stash', 'push', '-m', 'Today: pull', '--', ...changed]
    : ['stash', 'push', '--include-untracked', '-m', 'Today: pull'];
  try {
    git(stashArgs);
  } catch (stashErr) {
    const why = String(stashErr.stderr || '').trim() || stashErr.message || 'unknown error';
    const hint = placeholderHint(why);
    return { status: 500, body: { error: `Pull was blocked by local changes, and stashing them failed:\n${why}${hint ? '\n\n' + hint : ''}\n\nOriginal pull error:\n${pullErr.stderr || ''}`, setAside } };
  }

  try {
    git(PULL);
  } catch (retryErr) {
    // Pull still failed after the stash: put the changes back and report.
    try { git(['stash', 'pop']); } catch {}
    return { status: 500, body: { error: String(retryErr.stderr || '') || 'Pull failed even after stashing changes', setAside } };
  }

  const resolved = [];
  try {
    git(['stash', 'pop']);
  } catch (popErr) {
    // Conflicts between the pulled and stashed versions: resolve each with a
    // union merge (keep both sides' lines).
    let conflicted = [];
    try { conflicted = git(['diff', '--name-only', '--diff-filter=U']).trim().split('\n').filter(Boolean); } catch {}
    if (conflicted.length) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-union-'));
      for (const file of conflicted) {
        try {
          // Stage 1 = base, 2 = ours (pulled), 3 = theirs (stashed).
          const base = path.join(tmpDir, 'base');
          const ours = path.join(tmpDir, 'ours');
          const theirs = path.join(tmpDir, 'theirs');
          try { fs.writeFileSync(base, git(['show', ':1:' + file])); }
          catch { fs.writeFileSync(base, ''); } // no base = new file on one side
          fs.writeFileSync(ours, git(['show', ':2:' + file]));
          fs.writeFileSync(theirs, git(['show', ':3:' + file]));
          // merge-file writes into the first file; --union keeps both sides.
          try { execFileSync('git', ['merge-file', '--union', ours, base, theirs], { cwd: repoPath, encoding: 'utf8' }); } catch {}
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
