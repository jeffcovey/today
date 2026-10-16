import fs from 'fs';
import path from 'path';

const LOCK_RETRIES = 20;
const LOCK_RETRY_DELAY_MS = 50;
const STALE_LOCK_TIMEOUT_MS = 10_000;

export function acquireFileLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}`);
      const stat = fs.fstatSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      return stat;
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // The descriptor may already be closed.
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // The lock may already have been removed.
        }
      }
      if (error.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
          const current = fs.statSync(lockPath);
          if (current.dev === stat.dev && current.ino === stat.ino) {
            fs.unlinkSync(lockPath);
            continue;
          }
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }

      if (attempt < LOCK_RETRIES) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`Timed out acquiring file lock ${lockPath}`);
}

export function releaseFileLock(lockPath, lockStat) {
  try {
    const current = fs.statSync(lockPath);
    if (current.dev === lockStat.dev && current.ino === lockStat.ino) {
      fs.unlinkSync(lockPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export function withFileLocks(filePaths, callback) {
  const lockPaths = [...new Set(filePaths.map((filePath) => `${filePath}.lock`))].sort();
  const acquired = [];
  try {
    for (const lockPath of lockPaths) {
      acquired.push([lockPath, acquireFileLock(lockPath)]);
    }
    return callback();
  } finally {
    for (const [lockPath, stat] of acquired.reverse()) {
      releaseFileLock(lockPath, stat);
    }
  }
}
