/**
 * Tests for src/unison-args.js — the unison argv builder used by
 * bin/unison-sync. Guards the conflict/backup safety flags and the
 * `prefer` config mapping.
 */

import {
  buildUnisonArgs,
  resolvePrefer,
  BUILTIN_EXCLUDES,
  DEFAULT_MAX_BACKUPS,
} from '../src/unison-args.js';

const roots = {
  localRoot: '/app/vault',
  remoteRoot: 'ssh://root@203.0.113.5//opt/today/vault',
  sshArgs: '-p 22 -i /root/.ssh/do_deploy_key',
};

/** Return the value that follows a flag (first occurrence). */
function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe('resolvePrefer', () => {
  test('defaults to newer', () => {
    expect(resolvePrefer(undefined, roots)).toBe('newer');
    expect(resolvePrefer('', roots)).toBe('newer');
  });

  test('passes newer/older through', () => {
    expect(resolvePrefer('newer', roots)).toBe('newer');
    expect(resolvePrefer('older', roots)).toBe('older');
  });

  test('maps local/remote to the exact root strings unison expects', () => {
    expect(resolvePrefer('local', roots)).toBe(roots.localRoot);
    expect(resolvePrefer('remote', roots)).toBe(roots.remoteRoot);
  });

  test('rejects unknown values', () => {
    expect(() => resolvePrefer('mine', roots)).toThrow(/Invalid unison prefer "mine"/);
  });
});

describe('buildUnisonArgs', () => {
  test('starts with the two roots and keeps conflict copies by default', () => {
    const args = buildUnisonArgs(roots);
    expect(args.slice(0, 2)).toEqual([roots.localRoot, roots.remoteRoot]);
    expect(args).toContain('-batch');
    expect(args).toContain('-auto');
    expect(args).toContain('-copyonconflict');
    expect(argAfter(args, '-prefer')).toBe('newer');
    expect(argAfter(args, '-sshargs')).toBe(roots.sshArgs);
  });

  test('enables central backups of notes by default', () => {
    const args = buildUnisonArgs(roots);
    expect(argAfter(args, '-backup')).toBe('Name *.md');
    expect(argAfter(args, '-backuploc')).toBe('central');
    expect(argAfter(args, '-maxbackups')).toBe(String(DEFAULT_MAX_BACKUPS));
  });

  test('backups can be disabled and max_backups tuned', () => {
    const off = buildUnisonArgs({ ...roots, unisonConfig: { backups: false } });
    expect(off).not.toContain('-backup');
    expect(off).not.toContain('-maxbackups');
    // -copyonconflict is unconditional — it is not a backup setting
    expect(off).toContain('-copyonconflict');

    const tuned = buildUnisonArgs({ ...roots, unisonConfig: { max_backups: 12 } });
    expect(argAfter(tuned, '-maxbackups')).toBe('12');

    const bogus = buildUnisonArgs({ ...roots, unisonConfig: { max_backups: 0 } });
    expect(argAfter(bogus, '-maxbackups')).toBe(String(DEFAULT_MAX_BACKUPS));
  });

  test('prefer=remote resolves to the remote root', () => {
    const args = buildUnisonArgs({ ...roots, unisonConfig: { prefer: 'remote' } });
    expect(argAfter(args, '-prefer')).toBe(roots.remoteRoot);
  });

  test('adds -repeat watch unless oneShot', () => {
    expect(buildUnisonArgs(roots).slice(-2)).toEqual(['-repeat', 'watch']);
    expect(buildUnisonArgs({ ...roots, oneShot: true })).not.toContain('-repeat');
  });

  test('includes builtin excludes, user excludes, and selective paths', () => {
    const args = buildUnisonArgs({
      ...roots,
      unisonConfig: { paths: ['plans', 'notes'], excludes: ['Name *.bak'] },
    });
    for (const ex of BUILTIN_EXCLUDES) {
      expect(args).toContain(ex);
    }
    const ignores = args.filter((_, i) => args[i - 1] === '-ignore');
    expect(ignores).toEqual([...BUILTIN_EXCLUDES, 'Name *.bak']);
    const paths = args.filter((_, i) => args[i - 1] === '-path');
    expect(paths).toEqual(['plans', 'notes']);
  });
});
