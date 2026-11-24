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
