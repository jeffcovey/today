import { execGroup } from '../src/process-group.js';
import { execSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

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

  it('tears down detached groups on parent SIGTERM via shared shutdown handlers', async () => {
    const script = `
      import { execGroup, installProcessGroupShutdownHandlers } from '${path.join(PROJECT_ROOT, 'src/process-group.js')}';
      installProcessGroupShutdownHandlers();
      await execGroup("sh -c 'sleep 60 & echo $! ; wait'", {
        timeoutMs: 60000,
        onSpawn: (handle) => console.log('GROUP_PID:' + handle.pid)
      }).catch(() => {});
      setInterval(() => {}, 1000);
    `;

    const parent = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const childGroupPid = await new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Timed out waiting for child group PID'));
      }, 5000);
      parent.stdout.on('data', (data) => {
        if (settled) return;
        stdout += data.toString();
        const match = stdout.match(/GROUP_PID:(\d+)/);
        if (match) {
          settled = true;
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      parent.on('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Parent exited before reporting child group PID'));
      });
    });

    try {
      expect(Number.isInteger(childGroupPid)).toBe(true);

      process.kill(-parent.pid, 'SIGTERM');
      await wait(1500);

      expect(isAlive(childGroupPid)).toBe(false);
      expect(isAlive(parent.pid)).toBe(false);
    } finally {
      if (isAlive(parent.pid)) {
        try {
          process.kill(-parent.pid, 'SIGKILL');
        } catch {
          // Best-effort cleanup
        }
      }
    }
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

  it('counts maxBuffer in bytes for UTF-8 output', async () => {
    expect.assertions(2);
    try {
      await execGroup(`node -e "for (let i = 0; i < 40; i += 1) process.stdout.write('😀')"`, {
        timeoutMs: 5000,
        maxBuffer: 100
      });
    } catch (error) {
      expect(error.overflowed).toBe(true);
      expect(error.message).toMatch(/maxBuffer/);
    }
  });

  it('decodes UTF-8 characters split across chunk boundaries', async () => {
    const { stdout } = await execGroup(
      `node -e "process.stdout.write(Buffer.from([0xF0,0x9F])); setTimeout(() => process.stdout.write(Buffer.from([0x98,0x80])), 10)"`,
      { timeoutMs: 5000 }
    );
    expect(stdout).toBe('😀');
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
