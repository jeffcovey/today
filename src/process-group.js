import { spawn } from 'child_process';

/**
 * Run a shell command as its own process group, with a timeout that tears down
 * the entire tree.
 *
 * `child_process.exec`'s built-in timeout signals only the direct child. That is
 * fine for a leaf command, but every long-running job here is a chain several
 * levels deep — the scheduler's plugin sync runs
 *
 *   sh -c → npm exec → sh -c → dotenvx → bin/plugins sync → plugin read.js → claude
 *
 * so signalling the top `sh` left everything below it alive and reparented to
 * init. Each timed-out cron tick leaked a full sync, complete with a `claude`
 * subprocess, until the box ran out of CPU and RAM.
 *
 * Spawning detached makes the child a process-group leader, so negating its PID
 * in process.kill() reaches every descendant. See
 * https://github.com/jeffcovey/today/issues/383.
 *
 * @param {string} command - Shell command to run
 * @param {object} options
 * @param {string} options.cwd - Working directory
 * @param {object} options.env - Environment variables
 * @param {number} options.timeoutMs - Kill the group after this long
 * @param {number} [options.killGraceMs=10000] - Wait between SIGTERM and SIGKILL
 * @param {number} [options.maxBuffer] - Cap on captured stdout/stderr bytes
 * @param {(child: object) => void} [options.onSpawn] - Receives the child handle
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function execGroup(command, options) {
  const {
    cwd,
    env,
    timeoutMs,
    killGraceMs = 10_000,
    maxBuffer = 50 * 1024 * 1024,
    onSpawn
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: '/bin/sh',
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let escalateTimer = null;

    // Signal the group rather than the single child. A failure here just means
    // the group already exited, which is the outcome we wanted anyway.
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Group is already gone.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      escalateTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (escalateTimer) clearTimeout(escalateTimer);
    };

    // Overflow is an error, not a silent truncation. Callers parse stdout as
    // JSON, so handing back a clipped document would surface as a confusing
    // syntax error instead of the real cause. This matches what exec's
    // maxBuffer did before.
    let overflowed = false;
    const overflow = () => {
      if (overflowed) return;
      overflowed = true;
      cleanup();
      killGroup('SIGKILL');
      const error = new Error(`Command output exceeded maxBuffer of ${maxBuffer} bytes`);
      error.overflowed = true;
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      if (overflowed) return;
      stdout += chunk;
      if (stdout.length > maxBuffer) overflow();
    });

    child.stderr.on('data', (chunk) => {
      if (overflowed) return;
      stderr += chunk;
      if (stderr.length > maxBuffer) overflow();
    });

    child.on('error', (error) => {
      cleanup();
      reject(error);
    });

    child.on('close', (code, signal) => {
      cleanup();

      if (timedOut) {
        const error = new Error(
          `Command timed out after ${Math.round(timeoutMs / 1000)}s and its process group was terminated`
        );
        error.timedOut = true;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(
        signal
          ? `Command was killed with ${signal}`
          : `Command failed with exit code ${code}`
      );
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    // Exposed so callers can tear the group down on their own shutdown.
    if (onSpawn) onSpawn({ pid: child.pid, kill: killGroup });
  });
}
