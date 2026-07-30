import { execGroup } from '../src/process-group.js';
import { execSync } from 'child_process';

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('execGroup', () => {
  it('resolves with stdout for a successful command', async () => {
    const { stdout } = await execGroup('echo hello', { timeoutMs: 5000 });
    expect(stdout.trim()).toBe('hello');
  });

  it('rejects with stdout/stderr attached on non-zero exit', async () => {
    expect.assertions(3);
    try {
      await execGroup('echo out; echo err >&2; exit 3', { timeoutMs: 5000 });
    } catch (error) {
      expect(error.code).toBe(3);
      expect(error.stdout.trim()).toBe('out');
      expect(error.stderr.trim()).toBe('err');
    }
  });

  it('passes cwd and env through to the command', async () => {
    const { stdout } = await execGroup('printf "%s" "$MARKER"', {
      cwd: '/tmp',
      env: { ...process.env, MARKER: 'passed-through' },
      timeoutMs: 5000
    });
    expect(stdout).toBe('passed-through');
  });

  it('flags a timeout distinctly from an exit-code failure', async () => {
    expect.assertions(2);
    try {
      await execGroup('sleep 30', { timeoutMs: 300, killGraceMs: 200 });
    } catch (error) {
      expect(error.timedOut).toBe(true);
      expect(error.message).toMatch(/timed out/);
    }
  });

  // The regression this module exists for: `exec`'s timeout signalled only the
  // direct child, so grandchildren survived and reparented to init. See #383.
  it('kills grandchildren when the command times out', async () => {
    const marker = `execgroup-test-${process.pid}`;
    let grandchildPid;

    // The shell backgrounds a long sleep, so the sleep is a grandchild of the
    // spawned shell rather than the process the timeout signals directly.
    await expect(
      execGroup(`sh -c 'sleep 60 & echo $! ; wait' # ${marker}`, {
        timeoutMs: 500,
        killGraceMs: 200,
        onSpawn: () => {}
      }).catch((error) => {
        grandchildPid = Number(error.stdout.trim());
        throw error;
      })
    ).rejects.toThrow(/timed out/);

    expect(Number.isInteger(grandchildPid)).toBe(true);

    // Allow SIGTERM/SIGKILL to be delivered and reaped.
    await wait(1000);
    expect(isAlive(grandchildPid)).toBe(false);
  });

  it('runs the command in its own process group', async () => {
    const { stdout } = await execGroup('ps -o pgid= -p $$', { timeoutMs: 5000 });
    const childPgid = Number(stdout.trim());
    const ownPgid = Number(execSync(`ps -o pgid= -p ${process.pid}`).toString().trim());
    expect(childPgid).not.toBe(ownPgid);
  });

  // Callers JSON.parse stdout, so a clipped document would fail with a
  // misleading syntax error. Overflow has to be named.
  it('rejects rather than truncating when output exceeds maxBuffer', async () => {
    expect.assertions(2);
    try {
      await execGroup('for i in $(seq 1 500); do echo aaaaaaaaaa; done', {
        timeoutMs: 5000,
        maxBuffer: 100
      });
    } catch (error) {
      expect(error.overflowed).toBe(true);
      expect(error.message).toMatch(/maxBuffer/);
    }
  });

  it('does not treat output below maxBuffer as overflow', async () => {
    const { stdout } = await execGroup('echo small', { timeoutMs: 5000, maxBuffer: 1024 });
    expect(stdout.trim()).toBe('small');
  });

  it('reports spawn handles so callers can tear the group down', async () => {
    let handle;
    await execGroup('echo ok', {
      timeoutMs: 5000,
      onSpawn: (h) => { handle = h; }
    });
    expect(typeof handle.pid).toBe('number');
    expect(typeof handle.kill).toBe('function');
  });
});
