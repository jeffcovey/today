import { formatCommandFailure } from '../src/scheduler-utils.js';

describe('formatCommandFailure', () => {
  it('prefers child-process stderr over the generic command failure message', () => {
    const error = {
      message: 'Command failed: bin/git-sync',
      stderr: Buffer.from("fatal: could not read Username for 'https://github.com': terminal prompts disabled\n")
    };

    expect(formatCommandFailure(error)).toBe("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
  });

  it('falls back to the error message when stderr is unavailable', () => {
    expect(formatCommandFailure({ message: 'Command failed: bin/git-sync' })).toBe('Command failed: bin/git-sync');
  });
});
