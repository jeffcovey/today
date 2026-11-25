import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pullVault } from '../src/git-pull.js';

// Real repositories: `upstream` pushes to a bare `origin` (standing in for
// GitHub, e.g. a merged PR); `local` is the vault that pulls.
let dir, up, local;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (repo, file, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const read = (repo, file) => fs.readFileSync(path.join(repo, file), 'utf8');
const identity = (repo) => {
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
};
const pushUpstream = (files, message = 'upstream change') => {
  for (const [file, text] of Object.entries(files)) write(up, file, text);
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', message);
  git(up, 'push', '-q', 'origin', 'main');
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-vault-'));
  const origin = path.join(dir, 'origin.git');
  up = path.join(dir, 'upstream');
  local = path.join(dir, 'local');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, up);
  identity(up);
  write(up, 'diary.md', 'line 1\nline 2\nline 3\n');
  write(up, 'notes.md', 'notes\n');
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', 'first');
  git(up, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'clone', '-q', origin, local);
  identity(local);
  git(local, 'config', 'pull.rebase', 'false');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const stashes = () => git(local, 'stash', 'list');
const staged = () => git(local, 'diff', '--cached', '--name-only');

test('plain pull when nothing is in the way', () => {
  pushUpstream({ 'notes.md': 'notes\nmore\n' });
  const { status, body } = pullVault(local);
  expect(status).toBe(200);
  expect(body).toEqual({ ok: true });
  expect(read(local, 'notes.md')).toBe('notes\nmore\n');
});

test('stashes only the named files; edits survive; an unrelated untracked file is untouched', () => {
  pushUpstream({ 'diary.md': 'line 1\nline 2\nline 3\nline 4 upstream\n', 'inbox/.trash/a.txt': 'same\n' });
  write(local, 'diary.md', 'line 0 local\nline 1\nline 2\nline 3\n');
  write(local, 'inbox/.trash/a.txt', 'same\n'); // already delivered by sync, identical
  write(local, 'unrelated.md', 'keep me\n');
  const before = fs.statSync(path.join(local, 'unrelated.md')).mtimeMs;

  const { status, body } = pullVault(local);
  expect(status).toBe(200);
  expect(body).toMatchObject({ ok: true, stashed: true, resolved: [], setAside: [] });
  expect(read(local, 'diary.md')).toBe('line 0 local\nline 1\nline 2\nline 3\nline 4 upstream\n');
  expect(read(local, 'inbox/.trash/a.txt')).toBe('same\n');
  expect(read(local, 'unrelated.md')).toBe('keep me\n');
  expect(fs.statSync(path.join(local, 'unrelated.md')).mtimeMs).toBe(before);
  expect(stashes()).toBe('');
  expect(staged()).toBe('');
});

test('only untracked files in the way: a different local copy is kept aside', () => {
  pushUpstream({ 'plans/new.md': 'from GitHub\n' });
  write(local, 'plans/new.md', 'my own version\n');

  const { status, body } = pullVault(local);
  expect(status).toBe(200);
  expect(body.setAside).toHaveLength(1);
  expect(body.setAside[0]).toMatch(/^plans\/new\.md\.local-/);
  expect(read(local, 'plans/new.md')).toBe('from GitHub\n');
  expect(read(local, body.setAside[0])).toBe('my own version\n');
  expect(stashes()).toBe('');
});

test('conflicting edits are union-merged, the stash is dropped, nothing left staged', () => {
  pushUpstream({ 'diary.md': 'line 1\nline 2 upstream\nline 3\n' });
  write(local, 'diary.md', 'line 1\nline 2 local\nline 3\n');

  const { status, body } = pullVault(local);
  expect(status).toBe(200);
  expect(body).toMatchObject({ ok: true, stashed: true, resolved: ['diary.md'] });
  const merged = read(local, 'diary.md');
  expect(merged).toContain('line 2 upstream');
  expect(merged).toContain('line 2 local');
  expect(merged).not.toMatch(/^[<>=]{7}/m);
  expect(stashes()).toBe('');
  expect(staged()).toBe('');
});

test('a failure stashing cannot fix is reported without touching the vault', () => {
  git(local, 'remote', 'set-url', 'origin', path.join(dir, 'missing.git'));
  write(local, 'diary.md', 'line 0 local\nline 1\nline 2\nline 3\n');
  write(local, 'unrelated.md', 'keep me\n');

  const { status, body } = pullVault(local);
  expect(status).toBe(500);
  expect(body.error).toMatch(/does not appear to be a git repository|Could not read from remote/);
  expect(read(local, 'diary.md')).toBe('line 0 local\nline 1\nline 2\nline 3\n');
  expect(read(local, 'unrelated.md')).toBe('keep me\n');
  expect(stashes()).toBe('');
});

// Review fixes for PR #755.

// A git that fails on cue: a shell script that runs `caseArms` (arms of a
// `case "$*"` over its arguments) and then the real git. (File permissions
// won't do for failures, since tests may run as root.)
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const fakeGit = (caseArms) => {
  const file = path.join(dir, 'fake-git');
  fs.writeFileSync(file, `#!/bin/sh\ncase "$*" in\n${caseArms}\nesac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  return { gitBinary: file };
};
const failOn = (pattern) => fakeGit(`${pattern}) echo "fatal: injected failure" >&2; exit 1;;`);

test('a removed identical file is put back when setting the others aside fails', () => {
  pushUpstream({ 'plans/a.md': 'same\n', 'plans/b.md': 'from GitHub\n' });
  write(local, 'plans/a.md', 'same\n'); // identical: removed first
  write(local, 'plans/b.md', 'my own version\n');

  const { status, body } = pullVault(local, failOn("'hash-object -- plans/b.md'"));
  expect(status).toBe(500);
  expect(body.error).toMatch(/setting them aside failed/);
  expect(read(local, 'plans/a.md')).toBe('same\n');
  expect(read(local, 'plans/b.md')).toBe('my own version\n');
  expect(body.setAside).toEqual([]);
});

test('removed and renamed untracked files are put back when stashing fails', () => {
  pushUpstream({
    'diary.md': 'line 1\nline 2\nline 3\nline 4 upstream\n',
    'plans/a.md': 'same\n',
    'plans/b.md': 'from GitHub\n'
  });
  write(local, 'plans/a.md', 'same\n');
  write(local, 'plans/b.md', 'my own version\n');
  write(local, 'diary.md', 'line 0 local\nline 1\nline 2\nline 3\n');

  const { status, body } = pullVault(local, failOn("*'stash push'*"));
  expect(status).toBe(500);
  expect(body.error).toMatch(/stashing them failed/);
  expect(body.setAside).toEqual([]);
  expect(read(local, 'plans/a.md')).toBe('same\n');
  expect(read(local, 'plans/b.md')).toBe('my own version\n');
  expect(fs.readdirSync(path.join(local, 'plans')).sort()).toEqual(['a.md', 'b.md']);
  expect(read(local, 'diary.md')).toBe('line 0 local\nline 1\nline 2\nline 3\n');
});

test('untracked files are put back when the retried pull fails', () => {
  pushUpstream({ 'plans/a.md': 'same\n', 'plans/b.md': 'from GitHub\n' });
  write(local, 'plans/a.md', 'same\n');
  write(local, 'plans/b.md', 'my own version\n');
  // The first pull really runs (and is blocked by the files); the retry,
  // which only happens once they've been moved, fails.
  const { status, body } = pullVault(local, fakeGit(
    `*pull*) [ -e plans/a.md ] || { echo "fatal: network down" >&2; exit 1; };;`
  ));
  expect(status).toBe(500);
  expect(body.error).toMatch(/network down/);
  expect(body.setAside).toEqual([]);
  expect(read(local, 'plans/a.md')).toBe('same\n');
  expect(read(local, 'plans/b.md')).toBe('my own version\n');
});

test('a conflict merge-file cannot merge (binary) keeps the local edit in the stash', () => {
  write(up, 'photo.bin', Buffer.from([0, 1, 2, 3, 0, 10, 0]));
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', 'binary');
  git(up, 'push', '-q', 'origin', 'main');
  git(local, 'pull', '-q');
  pushUpstream({ 'photo.bin': Buffer.from([0, 9, 9, 9, 0, 10, 0]) });
  const mine = Buffer.from([0, 7, 7, 7, 0, 10, 0]);
  fs.writeFileSync(path.join(local, 'photo.bin'), mine);

  const { status, body } = pullVault(local);
  expect(status).toBe(500);
  expect(body.error).toMatch(/kept in the git stash/);
  expect(body.error).toMatch(/Unresolved: photo\.bin/);
  expect(stashes()).toMatch(/Today: pull/);
  const stashed = execFileSync('git', ['show', 'stash@{0}:photo.bin'], { cwd: local });
  expect(Buffer.compare(stashed, mine)).toBe(0);
});

test('a conflict in a non-ASCII filename is union-merged', () => {
  const file = '日記.md';
  pushUpstream({ [file]: 'line 1\nline 2\nline 3\n' }, 'add diary');
  git(local, 'pull', '-q');
  pushUpstream({ [file]: 'line 1\nline 2 upstream\nline 3\n' });
  write(local, file, 'line 1\nline 2 local\nline 3\n');

  const { status, body } = pullVault(local);
  expect(status).toBe(200);
  expect(body).toMatchObject({ ok: true, stashed: true, resolved: [file] });
  const merged = read(local, file);
  expect(merged).toContain('line 2 upstream');
  expect(merged).toContain('line 2 local');
  expect(stashes()).toBe('');
});

// Second review of #755.

test('a conflict in a tracked symlink is left unresolved and the stash kept', () => {
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'outside the vault\n');
  fs.symlinkSync('one', path.join(up, 'link'));
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', 'link');
  git(up, 'push', '-q', 'origin', 'main');
  git(local, 'pull', '-q');
  fs.unlinkSync(path.join(up, 'link'));
  fs.symlinkSync('two', path.join(up, 'link'));
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', 'retarget');
  git(up, 'push', '-q', 'origin', 'main');
  fs.unlinkSync(path.join(local, 'link'));
  fs.symlinkSync(outside, path.join(local, 'link'));

  const { status, body } = pullVault(local);
  expect(status).toBe(500);
  expect(body.error).toMatch(/Unresolved: link/);
  expect(fs.readFileSync(outside, 'utf8')).toBe('outside the vault\n');
  expect(stashes()).toMatch(/Today: pull/);
});

test('with pull.rebase, only the changed tracked files are stashed; untracked blockers are set aside', () => {
  git(local, 'config', 'pull.rebase', 'true');
  pushUpstream({ 'notes.md': 'notes\nmore\n', 'plans/new.md': 'from GitHub\n' });
  write(local, 'diary.md', 'line 0 local\nline 1\nline 2\nline 3\n');
  write(local, 'plans/new.md', 'my own version\n');
  write(local, 'unrelated.md', 'keep me\n');

  // Stashing untracked files (which reads every one, iCloud placeholders
  // included) must not happen.
  const { status, body } = pullVault(local, failOn('*include-untracked*|*--all*'));
  expect(status).toBe(200);
  expect(body).toMatchObject({ ok: true, stashed: true });
  expect(read(local, 'notes.md')).toBe('notes\nmore\n');
  expect(read(local, 'diary.md')).toBe('line 0 local\nline 1\nline 2\nline 3\n');
  expect(read(local, 'plans/new.md')).toBe('from GitHub\n');
  expect(body.setAside).toHaveLength(1);
  expect(read(local, body.setAside[0])).toBe('my own version\n');
  expect(read(local, 'unrelated.md')).toBe('keep me\n');
  expect(stashes()).toBe('');
});

test('after a conflicted pop, cleanly merged files are unstaged too; earlier staging is kept', () => {
  pushUpstream({
    'diary.md': 'line 1\nline 2 upstream\nline 3\n',
    'notes.md': 'notes\nupstream end\n'
  });
  write(local, 'diary.md', 'line 1\nline 2 local\nline 3\n'); // conflicts
  write(local, 'notes.md', 'local start\nnotes\n'); // merges cleanly
  write(local, 'staged.md', 'staged before the pull\n');
  git(local, 'add', 'staged.md');

  const { status, body } = pullVault(local);
  expect(status).toBe(200);
  expect(body.resolved).toEqual(['diary.md']);
  expect(read(local, 'notes.md')).toBe('local start\nnotes\nupstream end\n');
  expect(staged().trim().split('\n')).toEqual(['staged.md']);
  expect(stashes()).toBe('');
});

// Third review of #755.

test('filenames are literal pathspecs: resolving note[1].md does not stage note1.md', () => {
  pushUpstream({ 'note[1].md': 'a\nb\nc\n', 'note1.md': 'one\n' }, 'add notes');
  git(local, 'pull', '-q');
  pushUpstream({ 'note[1].md': 'a\nb upstream\nc\n' });
  write(local, 'note[1].md', 'a\nb local\nc\n');
  write(local, 'note1.md', 'one\nlocal, not to be staged\n');

  const { status, body } = pullVault(local);
  expect(status).toBe(200);
  expect(body.resolved).toEqual(['note[1].md']);
  expect(staged()).toBe('');
  expect(read(local, 'note1.md')).toBe('one\nlocal, not to be staged\n');
});

test('a conflict in a partly staged file is left unresolved, the stash kept', () => {
  pushUpstream({ 'diary.md': 'line 1\nline 2 upstream\nline 3\n' });
  write(local, 'diary.md', 'line 1\nline 2 staged\nline 3\n');
  git(local, 'add', 'diary.md');
  write(local, 'diary.md', 'line 1\nline 2 staged\nline 3\nunstaged\n');

  const { status, body } = pullVault(local);
  expect(status).toBe(500);
  expect(body.error).toMatch(/both staged and unstaged edits.*diary\.md/);
  expect(stashes()).toMatch(/Today: pull/);
  expect(git(local, 'show', 'stash@{0}:diary.md')).toBe('line 1\nline 2 staged\nline 3\nunstaged\n');
  expect(git(local, 'show', 'stash@{0}^2:diary.md')).toBe('line 1\nline 2 staged\nline 3\n');
});

test('an untracked symlink whose target matches the incoming file is renamed aside, not deleted', () => {
  const target = path.join(dir, 'target.md');
  fs.writeFileSync(target, 'from GitHub\n');
  pushUpstream({ 'plans/new.md': 'from GitHub\n' });
  fs.mkdirSync(path.join(local, 'plans'));
  fs.symlinkSync(target, path.join(local, 'plans/new.md'));

  const { status, body } = pullVault(local);
  expect(status).toBe(200);
  expect(body.setAside).toHaveLength(1);
  const aside = path.join(local, body.setAside[0]);
  expect(fs.lstatSync(aside).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(aside)).toBe(target);
  expect(read(local, 'plans/new.md')).toBe('from GitHub\n');
  expect(fs.lstatSync(path.join(local, 'plans/new.md')).isFile()).toBe(true);
});
