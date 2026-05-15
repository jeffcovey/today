/**
 * Tests for bin/unison-sync-healthcheck
 *
 * Runs the healthcheck as a subprocess and verifies it correctly writes /
 * clears the vault marker file based on the contents of the status file.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const healthcheckBin = path.join(projectRoot, 'bin', 'unison-sync-healthcheck');

const REAL_STATUS_FILE = path.join(projectRoot, '.data', 'unison', 'sync-status.json');
const REAL_VAULT = path.join(projectRoot, 'vault');
const REAL_MARKER = path.join(REAL_VAULT, '.unison-sync-status.md');

function runHealthcheckReal() {
  const result = spawnSync(process.execPath, [healthcheckBin], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKIP_DEP_CHECK: 'true',
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function writeRealStatus(fields) {
  const dir = path.join(projectRoot, '.data', 'unison');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REAL_STATUS_FILE, JSON.stringify(fields, null, 2) + '\n');
}

let previousStatusFile = null;
let previousMarker = null;

beforeEach(() => {
  // Snapshot existing files so we can restore them after the test
  previousStatusFile = fs.existsSync(REAL_STATUS_FILE)
    ? fs.readFileSync(REAL_STATUS_FILE, 'utf8') : null;
  previousMarker = fs.existsSync(REAL_MARKER)
    ? fs.readFileSync(REAL_MARKER, 'utf8') : null;
});

afterEach(() => {
  // Restore status file
  if (previousStatusFile !== null) {
    fs.writeFileSync(REAL_STATUS_FILE, previousStatusFile);
  } else if (fs.existsSync(REAL_STATUS_FILE)) {
    fs.unlinkSync(REAL_STATUS_FILE);
  }
  // Restore marker
  if (previousMarker !== null) {
    fs.mkdirSync(REAL_VAULT, { recursive: true });
    fs.writeFileSync(REAL_MARKER, previousMarker);
  } else if (fs.existsSync(REAL_MARKER)) {
    fs.unlinkSync(REAL_MARKER);
  }
});

describe('bin/unison-sync-healthcheck', () => {
  describe('no status file', () => {
    test('exits 0 and writes no marker when status file does not exist', () => {
      // Ensure no status file
      if (fs.existsSync(REAL_STATUS_FILE)) fs.unlinkSync(REAL_STATUS_FILE);

      const result = runHealthcheckReal();

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(REAL_MARKER)).toBe(false);
    });
  });

  describe('healthy state', () => {
    test('exits 0 and clears marker for a recent successful sync', () => {
      const recentIso = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
      writeRealStatus({ lastSuccessAt: recentIso, lastExitCode: 0, mode: 'once' });

      // Pre-write a stale marker to verify it gets cleared
      fs.mkdirSync(REAL_VAULT, { recursive: true });
      fs.writeFileSync(REAL_MARKER, '# old marker');

      const result = runHealthcheckReal();

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(REAL_MARKER)).toBe(false);
    });

    test('exits 0 for a recent watch-mode heartbeat', () => {
      const recentIso = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 min ago
      writeRealStatus({ lastSuccessAt: recentIso, lastExitCode: 0, mode: 'watch' });

      const result = runHealthcheckReal();

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(REAL_MARKER)).toBe(false);
    });
  });

  describe('stale state', () => {
    test('exits 1 and writes vault marker when last success was > 6 hours ago', () => {
      const staleIso = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(); // 7 h ago
      writeRealStatus({ lastSuccessAt: staleIso, lastExitCode: 0, mode: 'once' });

      const result = runHealthcheckReal();

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(REAL_MARKER)).toBe(true);
      const markerContent = fs.readFileSync(REAL_MARKER, 'utf8');
      expect(markerContent).toContain('STALE');
      expect(markerContent).toContain('Unison sync alert');
    });

    test('marker contains elapsed time description', () => {
      const staleIso = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(); // 8 h ago
      writeRealStatus({ lastSuccessAt: staleIso, lastExitCode: 0, mode: 'watch' });

      runHealthcheckReal();

      const marker = fs.readFileSync(REAL_MARKER, 'utf8');
      expect(marker).toMatch(/\d+h \d+m ago/);
    });
  });

  describe('failed state', () => {
    test('exits 1 and writes marker when last exit was failure and success is stale', () => {
      const staleIso = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
      const recentAttempt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      writeRealStatus({
        lastSuccessAt: staleIso,
        lastAttemptAt: recentAttempt,
        lastExitCode: 2,
        mode: 'once',
      });

      const result = runHealthcheckReal();

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(REAL_MARKER)).toBe(true);
      const markerContent = fs.readFileSync(REAL_MARKER, 'utf8');
      expect(markerContent).toContain('FAILED');
    });

    test('exits 0 (no alert) when last exit failed but success was recent', () => {
      // A transient failure followed by a recent success should not alert.
      const recentSuccess = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const recentAttempt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      writeRealStatus({
        lastSuccessAt: recentSuccess,
        lastAttemptAt: recentAttempt,
        lastExitCode: 2,
        mode: 'once',
      });

      const result = runHealthcheckReal();

      expect(result.exitCode).toBe(0);
    });
  });

  describe('never-succeeded state', () => {
    test('exits 0 while first attempt is still within grace period', () => {
      const recentAttempt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
      writeRealStatus({ lastAttemptAt: recentAttempt, lastExitCode: 2, mode: 'once' });

      const result = runHealthcheckReal();

      expect(result.exitCode).toBe(0);
    });

    test('exits 1 when no success and last attempt was long ago', () => {
      const oldAttempt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
      writeRealStatus({ lastAttemptAt: oldAttempt, lastExitCode: 2, mode: 'once' });

      const result = runHealthcheckReal();

      expect(result.exitCode).toBe(1);
      const marker = fs.readFileSync(REAL_MARKER, 'utf8');
      expect(marker).toContain('Unison sync alert');
    });
  });
});

