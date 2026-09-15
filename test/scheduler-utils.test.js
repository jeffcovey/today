import { formatCommandFailure } from '../src/scheduler-utils.js';

describe('formatCommandFailure', () => {
  test('includes trimmed stderr/stdout and exit metadata from execGroup failures', () => {
    const error = new Error('Command failed with exit code 2');
    error.code = 2;
    error.stderr = 'err-1\nerr-2\nerr-3\nerr-4\nerr-5\nerr-6\n';
    error.stdout = 'out-1\nout-2\nout-3\nout-4\nout-5\nout-6\n';

    const text = formatCommandFailure('Sync all plugins', error);

    expect(text).toContain('❌ Sync all plugins failed (exit code 2)');
    expect(text).toContain('err-2\nerr-3\nerr-4\nerr-5\nerr-6');
    expect(text).not.toContain('err-1');
    expect(text).toContain('stdout:\nout-2\nout-3\nout-4\nout-5\nout-6');
    expect(text).not.toContain('out-1');
  });

  test('preserves the timeout reason when timed-out jobs also produced output', () => {
    const error = new Error('Command timed out after 300s and its process group was terminated');
    error.timedOut = true;
    error.stderr = 'warn-1\nwarn-2\nwarn-3\nwarn-4\nwarn-5\nwarn-6\n';
    error.stdout = 'progress-1\nprogress-2\nprogress-3\nprogress-4\nprogress-5\nprogress-6\n';

    const text = formatCommandFailure('Sync all plugins', error);

    expect(text).toContain(
      '❌ Sync all plugins failed: Command timed out after 300s and its process group was terminated'
    );
    expect(text).toContain('warn-2\nwarn-3\nwarn-4\nwarn-5\nwarn-6');
    expect(text).not.toContain('warn-1');
    expect(text).toContain('stdout:\nprogress-2\nprogress-3\nprogress-4\nprogress-5\nprogress-6');
    expect(text).not.toContain('progress-1');
  });
});
