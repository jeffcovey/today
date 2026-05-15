/**
 * Tests for bin/unison-sync-healthcheck
 *
 * Runs the healthcheck as a subprocess and verifies it correctly writes /
 * clears the vault marker file based on the contents of the status file.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const healthcheckBin = path.join(projectRoot, 'bin', 'unison-sync-healthcheck');

// Use a temporary directory so we don't pollute the real vault or .data
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unison-hc-test-'));
const fakeVaultDir = path.join(tmpDir, 'vault');
const fakeDataDir = path.join(tmpDir, '.data', 'unison');
const STATUS_FILE = path.join(fakeDataDir, 'sync-status.json');
const MARKER_FILE = path.join(fakeVaultDir, '.unison-sync-status.md');
const FAKE_CONFIG = path.join(tmpDir, 'config.toml');

function runHealthcheck() {
  try {
    const output = execSync(`node ${healthcheckBin}`, {
      cwd: tmpDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        TODAY_CONFIG: FAKE_CONFIG,
        // Override PROJECT_ROOT so the script uses our tmp dir
        // (The script derives PROJECT_ROOT from __dirname, so we
        //  symlink .data and vault into tmpDir instead)
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: output };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function writeStatus(fields) {
  fs.mkdirSync(fakeDataDir, { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(fields, null, 2) + '\n');
}

function markerExists() {
  return fs.existsSync(MARKER_FILE);
}

beforeAll(() => {
  // Create fake vault directory and config
  fs.mkdirSync(fakeVaultDir, { recursive: true });
  fs.mkdirSync(fakeDataDir, { recursive: true });

  // Minimal config pointing at our fake vault
  fs.writeFileSync(FAKE_CONFIG, `vault_path = "${fakeVaultDir}"\n`);

  // Symlink our fake .data/unison into the project's real .data/unison path
  // by overriding via env; since the script resolves PROJECT_ROOT from
  // __dirname (bin/../), we can't override it via env. Instead we write the
  // real status file and vault marker paths using the project root paths and
  // restore them after.
});

afterAll(() => {
  // Clean up temp directory
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Helper: run healthcheck with a real status file in PROJECT_ROOT ──────────
//
// Because the healthcheck resolves paths from __dirname (immutable at parse
// time), we write/clean the status file and vault marker in the project tree
// rather than the temp dir, and restore them fully in afterEach.

const REAL_STATUS_FILE = path.join(projectRoot, '.data', 'unison', 'sync-status.json');
const REAL_VAULT = path.join(projectRoot, 'vault');
const REAL_MARKER = path.join(REAL_VAULT, '.unison-sync-status.md');

function runHealthcheckReal() {
  try {
    const output = execSync(`node ${healthcheckBin}`, {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SKIP_DEP_CHECK: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: output };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
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
