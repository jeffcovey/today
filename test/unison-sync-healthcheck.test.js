/**
 * Tests for bin/unison-sync-healthcheck
 *
 * Runs the healthcheck as a subprocess and verifies it correctly writes /
 * clears the vault marker file based on the contents of the status file.
 *
 * Uses UNISON_STATUS_FILE and UNISON_VAULT_PATH env-var overrides so the
 * tests never touch the real project filesystem and Jest workers don't
 * interfere with each other.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const healthcheckBin = path.join(projectRoot, 'bin', 'unison-sync-healthcheck');

// Isolated tmpdir — never touches .data/ or vault/ in the real project tree.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unison-hc-test-'));
const TMP_STATUS_FILE = path.join(tmpDir, 'sync-status.json');
const TMP_VAULT_DIR = path.join(tmpDir, 'vault');
const TMP_MARKER = path.join(TMP_VAULT_DIR, '.unison-sync-status.md');

function runHealthcheck() {
  const result = spawnSync(process.execPath, [healthcheckBin], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKIP_DEP_CHECK: 'true',
      UNISON_STATUS_FILE: TMP_STATUS_FILE,
      UNISON_VAULT_PATH: TMP_VAULT_DIR,
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function writeStatus(fields) {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(TMP_STATUS_FILE, JSON.stringify(fields, null, 2) + '\n');
}

beforeEach(() => {
  // Start each test with a clean slate in the tmpdir.
  fs.mkdirSync(TMP_VAULT_DIR, { recursive: true });
  if (fs.existsSync(TMP_STATUS_FILE)) fs.unlinkSync(TMP_STATUS_FILE);
  if (fs.existsSync(TMP_MARKER)) fs.unlinkSync(TMP_MARKER);
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('bin/unison-sync-healthcheck', () => {
  describe('no status file', () => {
    test('exits 0 and writes no marker when status file does not exist', () => {
      const result = runHealthcheck();

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(TMP_MARKER)).toBe(false);
    });
  });

  describe('healthy state', () => {
    test('exits 0 and clears marker for a recent successful sync (once mode)', () => {
      const recentIso = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
      writeStatus({ lastSuccessAt: recentIso, lastExitCode: 0, mode: 'once' });

      // Pre-write a stale marker to verify it gets cleared.
      fs.writeFileSync(TMP_MARKER, '# old marker');

      const result = runHealthcheck();

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(TMP_MARKER)).toBe(false);
    });

    test('exits 0 for a recent watch-mode heartbeat', () => {
      const recentIso = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 min ago
      writeStatus({ lastHeartbeatAt: recentIso, mode: 'watch' });

      const result = runHealthcheck();

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(TMP_MARKER)).toBe(false);
    });
  });

  describe('stale state', () => {
    test('exits 1 and writes vault marker when last success was > 6 hours ago (once mode)', () => {
      const staleIso = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(); // 7 h ago
      writeStatus({ lastSuccessAt: staleIso, lastExitCode: 0, mode: 'once' });

      const result = runHealthcheck();

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(TMP_MARKER)).toBe(true);
      const markerContent = fs.readFileSync(TMP_MARKER, 'utf8');
      expect(markerContent).toContain('STALE');
      expect(markerContent).toContain('Unison sync alert');
      expect(markerContent).toContain('Last successful sync');
    });

    test('exits 1 and writes vault marker when heartbeat is > 6 hours stale (watch mode)', () => {
      const staleIso = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(); // 7 h ago
      writeStatus({ lastHeartbeatAt: staleIso, mode: 'watch' });

      const result = runHealthcheck();

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(TMP_MARKER)).toBe(true);
      const markerContent = fs.readFileSync(TMP_MARKER, 'utf8');
      expect(markerContent).toContain('STALE');
      expect(markerContent).toContain('Last heartbeat');
    });

    test('marker contains elapsed time description', () => {
      const staleIso = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(); // 8 h ago
      writeStatus({ lastSuccessAt: staleIso, lastExitCode: 0, mode: 'once' });

      runHealthcheck();

      const marker = fs.readFileSync(TMP_MARKER, 'utf8');
      expect(marker).toMatch(/\d+h \d+m ago/);
    });
  });

  describe('failed state', () => {
    test('exits 1 and writes marker when last exit was failure and success is stale', () => {
      const staleIso = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
      const recentAttempt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      writeStatus({
        lastSuccessAt: staleIso,
        lastAttemptAt: recentAttempt,
        lastExitCode: 2,
        mode: 'once',
      });

      const result = runHealthcheck();

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(TMP_MARKER)).toBe(true);
      const markerContent = fs.readFileSync(TMP_MARKER, 'utf8');
      expect(markerContent).toContain('FAILED');
    });

    test('exits 0 (no alert) when last exit failed but success was recent', () => {
      // A transient failure followed by a recent success should not alert.
      const recentSuccess = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const recentAttempt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      writeStatus({
        lastSuccessAt: recentSuccess,
        lastAttemptAt: recentAttempt,
        lastExitCode: 2,
        mode: 'once',
      });

      const result = runHealthcheck();

      expect(result.exitCode).toBe(0);
    });
  });

  describe('never-succeeded state', () => {
    test('exits 0 while first attempt is still within grace period', () => {
      const recentAttempt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
      writeStatus({ lastAttemptAt: recentAttempt, lastExitCode: 2, mode: 'once' });

      const result = runHealthcheck();

      expect(result.exitCode).toBe(0);
    });

    test('exits 1 when no success and last attempt was long ago', () => {
      const oldAttempt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
      writeStatus({ lastAttemptAt: oldAttempt, lastExitCode: 2, mode: 'once' });

      const result = runHealthcheck();

      expect(result.exitCode).toBe(1);
      const marker = fs.readFileSync(TMP_MARKER, 'utf8');
      expect(marker).toContain('Unison sync alert');
    });
  });

  describe('corrupt status file', () => {
    test('exits 1 (not silent no-op) when status file contains partial JSON', () => {
      // Simulate a truncated write — the file exists but JSON is unparseable.
      // This must NOT be treated as "unison not configured" (exit 0 with no
      // marker), which would silently disable monitoring on the very condition
      // it is designed to catch.
      fs.writeFileSync(TMP_STATUS_FILE, '{"lastSuccessAt": "2026-01-');

      const result = runHealthcheck();

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(TMP_MARKER)).toBe(true);
    });

    test('exits 1 (stale, not silently healthy) when timestamp is malformed', () => {
      writeStatus({ lastSuccessAt: 'not-a-date', lastExitCode: 0, mode: 'once' });

      const result = runHealthcheck();

      // A corrupt timestamp must not be treated as healthy.
      expect(result.exitCode).toBe(1);
    });
  });
});

