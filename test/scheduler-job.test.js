import { jest } from '@jest/globals';
import { runCommand } from '../src/scheduler-job.js';

describe('runCommand', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('logs child stderr and stdout details when a job fails', async () => {
    const error = new Error('Command failed: bin/git-sync');
    error.code = 2;
    error.stderr = 'err-1\nerr-2\nerr-3\nerr-4\nerr-5\nerr-6\n';
    error.stdout = 'out-1\nout-2\nout-3\nout-4\nout-5\nout-6\n';

    const exec = jest.fn().mockRejectedValue(error);

    await runCommand('bin/git-sync', 'Pull/rebase/push the vault via git every minute', {
      projectRoot: '/tmp/project',
      timeoutMs: 1000,
      existsSync: () => false,
      exec,
    });

    expect(exec).toHaveBeenCalledWith('bin/git-sync', {
      cwd: '/tmp/project',
      env: process.env,
      timeoutMs: 1000,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('❌ Pull/rebase/push the vault via git every minute failed (exit code 2)')
    );
    const failureText = consoleErrorSpy.mock.calls.at(-1)[0];
    expect(failureText).toContain('err-2\nerr-3\nerr-4\nerr-5\nerr-6');
    expect(failureText).not.toContain('err-1');
    expect(failureText).toContain('stdout:\nout-2\nout-3\nout-4\nout-5\nout-6');
    expect(failureText).not.toContain('out-1');
  });
});
