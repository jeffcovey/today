import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';

const execFile = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  execFile
}));

const { runTrackCommand, resetTrackCommandQueueForTests } = await import('../src/track-command.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const flushQueue = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('runTrackCommand', () => {
  beforeEach(() => {
    execFile.mockReset();
    resetTrackCommandQueueForTests();
  });

  test('overlapping calls do not interleave', async () => {
    const callbacks = [];
    const events = [];

    execFile.mockImplementation((file, args, options, callback) => {
      events.push(`start:${args[0]}`);
      callbacks.push(() => {
        events.push(`finish:${args[0]}`);
        callback(null, `${args[0]} ok`, '');
      });
    });

    const first = runTrackCommand(['start', '--', 'Review plan']);
    const second = runTrackCommand(['stop']);
    await flushQueue();

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      'bin/track',
      ['start', '--', 'Review plan'],
      expect.objectContaining({
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60000
      }),
      expect.any(Function)
    );
    expect(events).toEqual(['start:start']);

    callbacks[0]();
    await expect(first).resolves.toBe('start ok');
    await flushQueue();

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['start:start', 'finish:start', 'start:stop']);

    callbacks[1]();
    await expect(second).resolves.toBe('stop ok');
    expect(events).toEqual(['start:start', 'finish:start', 'start:stop', 'finish:stop']);
  });

  test('a rejection does not break the queue for later callers', async () => {
    const callbacks = [];

    execFile.mockImplementation((file, args, options, callback) => {
      callbacks.push({ args, callback });
    });

    const first = runTrackCommand(['start', '--', 'Review plan']);
    const second = runTrackCommand(['stop']);
    await flushQueue();

    const error = new Error('track failed');
    callbacks[0].callback(error, '', 'stderr details');
    await expect(first).rejects.toMatchObject({
      message: expect.stringContaining('stderr details')
    });
    await flushQueue();

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1][1]).toEqual(['stop']);

    callbacks[1].callback(null, 'stop ok', '');
    await expect(second).resolves.toBe('stop ok');
  });
});
