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
  // Vault filenames are passed to git as-is, so every pathspec is literal:
  // `note[1].md` must not also match `note1.md`.
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
  const git = (args, timeout = 30000) => execFileSync(gitBinary, args, {
    cwd: repoPath, env, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024
  });
  // File contents as raw bytes, so non-UTF-8 and binary files aren't mangled.
  const gitBytes = (args) => execFileSync(gitBinary, args, {
    cwd: repoPath, env, timeout: 30000, maxBuffer: 100 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
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
  // Returns an error response if that fails (after putting files back).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const moveUntrackedAside = (files) => {
    try {
      for (const file of files) {
        // Only an ordinary file can be an identical copy; anything else (a
        // symlink, say: hashing it would read its target) is renamed aside.
        const regular = fs.lstatSync(path.join(repoPath, file)).isFile();
        let incoming = '';
        if (regular) {
          try { incoming = git(['rev-parse', '@{upstream}:' + file]).trim(); } catch {}
        }
        const local = incoming ? git(['hash-object', '--', file]).trim() : '';
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
      return null;
    } catch (prepErr) {
      const note = restoreUntracked();
      const why = String(prepErr.stderr || '').trim() || prepErr.message || 'unknown error';
      const hint = placeholderHint(why);
      return { status: 500, body: { error: `Pull was blocked by local files, and setting them aside failed:\n${why}${hint ? '\n\n' + hint : ''}${note}`, setAside } };
    }
  };

  const prepFailed = moveUntrackedAside(untracked);
  if (prepFailed) return prepFailed;

  // The tracked files to stash. When git didn't name them ("cannot pull
  // with rebase: You have unstaged changes"), ask it which tracked files
  // have local changes, rather than stashing everything (which would read
  // every untracked file too).
  let toStash = changed;
  if (!listed) {
    const names = (args) => git(args).split('\0').filter(Boolean);
    try {
      toStash = [...new Set([...names(['diff', '--name-only', '-z']), ...names(['diff', '--cached', '--name-only', '-z'])])];
    } catch (diffErr) {
      return { status: 500, body: { error: `Pull was blocked by local changes, and listing them failed:\n${String(diffErr.stderr || '').trim() || diffErr.message}\n\nOriginal pull error:\n${pullErr.stderr || ''}`, setAside } };
    }
  }

  if (toStash.length === 0) {
    // Only untracked files were in the way, and they're handled (or git
    // named nothing we can move: report its error).
    if (!listed) return { status: 500, body: { error: String(pullErr.stderr || '') || 'Failed to pull', setAside } };
    try {
      git(PULL);
      return { status: 200, body: { ok: true, setAside } };
    } catch (retryErr) {
      const note = restoreUntracked();
      return { status: 500, body: { error: (String(retryErr.stderr || '') || 'Pull failed') + note, setAside } };
    }
  }

  // What was staged before, so the files re-applied below can be returned
  // to that state; and which files were only partly staged (staged edits
  // plus further unstaged ones), which a conflicted pop can't restore.
  let stagedBefore = [];
  let partlyStaged = [];
  try {
    stagedBefore = git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
    const unstaged = git(['diff', '--name-only', '-z']).split('\0').filter(Boolean);
    partlyStaged = stagedBefore.filter(f => unstaged.includes(f));
  } catch {}

  try {
    git(['--literal-pathspecs', 'stash', 'push', '-m', 'Today: pull', '--', ...toStash]);
  } catch (stashErr) {
    const note = restoreUntracked();
    const why = String(stashErr.stderr || '').trim() || stashErr.message || 'unknown error';
    const hint = placeholderHint(why);
    return { status: 500, body: { error: `Pull was blocked by local changes, and stashing them failed:\n${why}${hint ? '\n\n' + hint : ''}\n\nOriginal pull error:\n${pullErr.stderr || ''}${note}`, setAside } };
  }

  const retryFailed = (retryErr) => {
    // Pull still failed after the stash: put the changes back and report.
    try { git(['stash', 'pop']); } catch {}
    const note = restoreUntracked();
    return { status: 500, body: { error: (String(retryErr.stderr || '') || 'Pull failed even after stashing changes') + note, setAside } };
  };
  try {
    git(PULL);
  } catch (retryErr) {
    // With the tracked changes out of the way, git may now name untracked
    // files that are in the way (it checks those later, e.g. when
    // rebasing): set those aside too and try once more.
    const more = pathsBlockingPull(retryErr.stderr).untracked;
    if (listed || more.length === 0) return retryFailed(retryErr);
    const morePrepFailed = moveUntrackedAside(more);
    if (morePrepFailed) {
      try { git(['stash', 'pop']); } catch {}
      return morePrepFailed;
    }
    try {
      git(PULL);
    } catch (againErr) {
      return retryFailed(againErr);
    }
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
    // A file that was partly staged would come back wholly staged (git
    // stages every re-applied file after a conflict), so the next commit
    // would take edits that were left unstaged. Don't resolve anything then.
    let reapplied = [];
    try { reapplied = git(['stash', 'show', '--name-only', '-z', 'stash@{0}']).split('\0').filter(Boolean); } catch {}
    const partlyStagedReapplied = reapplied.filter(f => partlyStaged.includes(f));
    if (partlyStagedReapplied.length) {
      const why = String(popErr.stderr || '').trim() || popErr.message;
      return { status: 500, body: { error: `Pulled, but re-applying your local changes hit a conflict, and these files had both staged and unstaged edits, which can't be put back as they were: ${partlyStagedReapplied.join(', ')}\n\nYour changes are kept in the git stash ("Today: pull"); restore them with git stash pop.\n\n${why}`, setAside } };
    }
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
          // Only ordinary files: copying onto a symlink would write to
          // wherever it points, perhaps outside the vault. Anything else
          // stays unresolved, and the stash is kept.
          const modes = git(['ls-files', '-s', '-z', '--', file]).split('\0').filter(Boolean).map(entry => entry.split(' ')[0]);
          if (modes.some(mode => mode !== '100644' && mode !== '100755')) throw new Error('not a regular file in git (mode ' + modes.join(', ') + ')');
          const target = path.join(repoPath, file);
          let stat = null;
          try { stat = fs.lstatSync(target); } catch {}
          if (stat && !stat.isFile()) throw new Error('not a regular file in the working tree');
          fs.copyFileSync(ours, target);
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
    // All resolved: the stash entry is no longer needed. A conflicted pop
    // leaves every re-applied file staged, the cleanly merged ones too, so
    // unstage all of them except what was staged before the pull.
    try { git(['stash', 'drop']); } catch {}
    const unstage = [...new Set([...reapplied, ...resolved])].filter(f => !stagedBefore.includes(f));
    if (unstage.length) {
      try { git(['--literal-pathspecs', 'reset', '-q', '--', ...unstage]); } catch {}
    }
  }
  return { status: 200, body: { ok: true, stashed: true, resolved, setAside } };
}
