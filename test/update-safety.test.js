import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import {
  ensureBetterSqliteBinding,
  recoverInterruptedUpdate,
  stashUpdateChanges
} from '../bin/lib/update-safety.js';

describe('update safety', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'today-update-safety-'));
    mkdirSync(path.join(projectRoot, '.git'));
    execSync('git init -b main', { cwd: projectRoot, stdio: 'pipe' });
    execSync('git config user.email today@example.test', { cwd: projectRoot, stdio: 'pipe' });
    execSync('git config user.name Today Test', { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(path.join(projectRoot, 'tracked.txt'), 'committed\n');
    execSync('git add tracked.txt && git commit -m initial', { cwd: projectRoot, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('ensureBetterSqliteBinding', () => {
    test('does not rebuild a binding that loads successfully', () => {
      const exec = jest.fn();
      class FakeDatabase {
        close() {}
      }

      expect(ensureBetterSqliteBinding(projectRoot, exec, () => FakeDatabase)).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    });

    test('rebuilds an unloadable binding and verifies it again', () => {
      let canLoad = false;
      const exec = jest.fn(() => {
        canLoad = true;
      });
      class FakeDatabase {
        constructor() {
          if (!canLoad) throw new Error('native binding unavailable');
        }
        close() {}
      }

      expect(ensureBetterSqliteBinding(projectRoot, exec, () => FakeDatabase)).toBe(true);
      expect(exec).toHaveBeenCalledWith('npm rebuild better-sqlite3', {
        cwd: projectRoot,
        stdio: 'inherit'
      });
    });

    test('fails clearly when rebuilding does not produce a loadable binding', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const exec = jest.fn();
      class FakeDatabase {
        constructor() {
          throw new Error('native binding unavailable');
        }
      }

      expect(ensureBetterSqliteBinding(projectRoot, exec, () => FakeDatabase)).toBe(false);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '❌ better-sqlite3 is still not loadable after rebuilding.'
      );
    });
  });

  test('silently skips a directory outside a Git worktree', () => {
    rmSync(path.join(projectRoot, '.git'), { recursive: true, force: true });
    const exec = jest.fn();
    const logger = { error: jest.fn(), log: jest.fn() };

    expect(recoverInterruptedUpdate(projectRoot, exec, logger)).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  test('silently skips when Git is unavailable', () => {
    rmSync(path.join(projectRoot, '.git'), { recursive: true, force: true });
    writeFileSync(path.join(projectRoot, '.git'), 'gitdir: missing\n');
    const exec = jest.fn(() => {
      throw new Error('spawnSync git ENOENT');
    });
    const logger = { error: jest.fn(), log: jest.fn() };

    expect(recoverInterruptedUpdate(projectRoot, exec, logger)).toBe(true);
    expect(exec).toHaveBeenCalledWith('git rev-parse --is-inside-work-tree', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  test('restores a named update stash on startup', () => {
    writeFileSync(path.join(projectRoot, 'tracked.txt'), 'local change\n');
    writeFileSync(path.join(projectRoot, 'untracked.txt'), 'untracked change\n');
    const updateStash = stashUpdateChanges(projectRoot, execSync);
    const head = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf8'
    }).trim();
    writeFileSync(path.join(projectRoot, '.git', 'MERGE_HEAD'), `${head}\n`);

    expect(existsSync(path.join(projectRoot, 'untracked.txt'))).toBe(false);
    expect(recoverInterruptedUpdate(projectRoot, execSync)).toBe(true);
    expect(readFileSync(path.join(projectRoot, 'tracked.txt'), 'utf8')).toBe('local change\n');
    expect(readFileSync(path.join(projectRoot, 'untracked.txt'), 'utf8')).toBe('untracked change\n');
    expect(existsSync(updateStash.markerPath)).toBe(false);
    expect(existsSync(path.join(projectRoot, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  test('clears merge metadata when the merge commit is already complete', () => {
    const head = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf8'
    }).trim();
    writeFileSync(path.join(projectRoot, '.git', 'MERGE_HEAD'), `${head}\n`);

    expect(recoverInterruptedUpdate(projectRoot, execSync)).toBe(true);
    expect(existsSync(path.join(projectRoot, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  test('reports merge metadata that cannot safely be cleared', () => {
    const logger = { error: jest.fn(), log: jest.fn() };
    const head = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf8'
    }).trim();
    writeFileSync(path.join(projectRoot, '.git', 'MERGE_HEAD'), `${head}\n`);
    writeFileSync(path.join(projectRoot, 'tracked.txt'), 'staged change\n');
    execSync('git add tracked.txt', { cwd: projectRoot, stdio: 'pipe' });

    expect(recoverInterruptedUpdate(projectRoot, execSync, logger)).toBe(false);
    expect(existsSync(path.join(projectRoot, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      '⚠️  An unfinished or unresolved merge is present. Resolve it before updating.'
    );
  });
});
