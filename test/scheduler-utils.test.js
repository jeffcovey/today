import { formatCommandFailure } from '../src/scheduler-utils.js';

describe('formatCommandFailure', () => {
  test('includes trimmed stderr/stdout and exit metadata from execGroup failures', () => {
    const error = new Error('Command failed: bin/git-sync');
    error.code = 2;
    error.stderr = 'err-1\nerr-2\nerr-3\nerr-4\nerr-5\nerr-6\n';
    error.stdout = 'out-1\nout-2\nout-3\nout-4\nout-5\nout-6\n';

    const text = formatCommandFailure('Pull/rebase/push the vault via git every minute', error);

    expect(text).toContain('❌ Pull/rebase/push the vault via git every minute failed (exit code 2)');
    expect(text).toContain('err-2\nerr-3\nerr-4\nerr-5\nerr-6');
    expect(text).not.toContain('err-1');
    expect(text).toContain('stdout:\nout-2\nout-3\nout-4\nout-5\nout-6');
    expect(text).not.toContain('out-1');
  });
});
