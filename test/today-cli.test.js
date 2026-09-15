import { execSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const todayBin = path.join(projectRoot, 'bin', 'today');

/**
 * Helper to run bin/today with given arguments
 */
function runToday(args = '', options = {}) {
  const { env: customEnv, ...execOptions } = options;
  const cmd = `node ${todayBin} ${args}`;
  try {
    const output = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        // Skip dependency checks in tests for faster execution
        SKIP_DEP_CHECK: 'true',
        // Skip database health checks in tests for faster execution
        SKIP_DB_HEALTH: 'true',
        // Skip slow context gathering for faster tests
        SKIP_CONTEXT: 'true',
        // Skip the interactive update-check prompt — when the local checkout
        // is behind origin/main (e.g., after a Dependabot merge) bin/today
        // would otherwise block on readline and the assertions would fail
        // against the prompt output instead of the help text.
        SKIP_UPDATE_CHECK: 'true',
        ...customEnv,
      },
      ...execOptions,
    });
    return { stdout: output, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.status || 1,
    };
  }
}

function withEncryptedEnvDir(callback) {
  const envDir = mkdtempSync(path.join(tmpdir(), 'today-env-'));
  const envPath = path.join(envDir, '.env');
  const envKeysPath = path.join(envDir, '.env.keys');
  const dotenvxCliPath = path.join(envDir, 'node_modules', '@dotenvx', 'dotenvx', 'src', 'cli', 'dotenvx.js');

  writeFileSync(envPath, 'DOTENV_PUBLIC_KEY=dummy-public-key\n');
  writeFileSync(envKeysPath, 'DUMMY_DOTENV_PRIVATE_KEY=dummy-private-key\n');
  mkdirSync(path.dirname(dotenvxCliPath), { recursive: true });
  writeFileSync(dotenvxCliPath, '');

  try {
    return callback(envDir);
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
}

function withFakeNpx(callback) {
  const fakeBinDir = mkdtempSync(path.join(tmpdir(), 'today-fake-bin-'));
  const markerPath = path.join(fakeBinDir, 'dotenvx-ran');
  const fakeNpxPath = path.join(fakeBinDir, 'npx');
  const fakeNpxCmdPath = path.join(fakeBinDir, 'npx.CMD');

  writeFileSync(fakeNpxPath, '#!/bin/sh\nprintf "dotenvx-called" > "$NPX_MARKER"\nexit 0\n');
  writeFileSync(fakeNpxCmdPath, '@echo off\r\n> "%NPX_MARKER%" echo dotenvx-called\r\nexit /b 0\r\n');
  chmodSync(fakeNpxPath, 0o755);

  try {
    return callback({
      markerPath,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ''}`,
        NPX_MARKER: markerPath,
      },
    });
  } finally {
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
}

describe('bin/today CLI', () => {
  describe('--help', () => {
    test('should display help message', () => {
      const result = runToday('--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('AI-powered daily review and planning tool');
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('Commands:');
      expect(result.stdout).toContain('Options:');
    });

    test('should show all available commands', () => {
      const result = runToday('--help');

      expect(result.stdout).toContain('now');
      expect(result.stdout).toContain('dry-run');
    });

    test('should show --no-sync option', () => {
      const result = runToday('--help');

      expect(result.stdout).toContain('--no-sync');
    });

    test('-h should also show help', () => {
      const result = runToday('-h');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('AI-powered daily review and planning tool');
    });
  });

  // Note: init command is currently disabled, pending migration to plugin system
  describe('init', () => {
    test('should show that init is disabled but not crash', () => {
      const result = runToday('init');

      // init is disabled, so it will run the default interactive session
      // but without --no-sync it may timeout or fail gracefully
      // Just check it doesn't crash immediately
      expect(result.stdout + (result.stderr || '')).toBeTruthy();
    });
  });

  describe('dry-run', () => {
    test('should output the prompt without running Claude', () => {
      const result = runToday('dry-run --no-sync');

      expect(result.exitCode).toBe(0);
      // dry-run outputs the prompt that would be sent to Claude
      expect(result.stdout).toContain('You are an agent helping a user');
    });

    test('should include data context in dry-run output', () => {
      const result = runToday('dry-run --no-sync');

      // Should contain context sections
      expect(result.stdout).toContain('Data Sources');
    });

    test('should not actually start Claude session', () => {
      const result = runToday('dry-run --no-sync');

      // Should not show session end messages (means it didn't run the AI)
      expect(result.stdout).not.toContain('Session ended');
      // Should not actually write files
      expect(result.stdout).not.toMatch(/^Updated.*\.md/m);
    });
  });

  describe('--no-sync', () => {
    test('should skip sync step with dry-run', () => {
      const result = runToday('dry-run --no-sync');

      // Should not show sync messages
      expect(result.stdout).not.toContain('Syncing data');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('date components', () => {
    test('dry-run should include current time context', () => {
      const result = runToday('dry-run --no-sync');

      // Should include pre-computed context with current time
      expect(result.stdout).toContain('Current Time');
      // Should include user profile section
      expect(result.stdout).toContain('User Profile');
    });
  });

  describe('error handling', () => {
    test('should handle unknown commands gracefully', () => {
      const result = runToday('unknown-command');

      // Should either show help or an error, not crash
      expect(result.stdout + (result.stderr || '')).toBeTruthy();
    });
  });

  describe('startup optimization', () => {
    test.each(['--help', '--version'])('%s should skip dotenvx re-exec', (arg) => {
      withFakeNpx(({ markerPath, env }) => {
        withEncryptedEnvDir(cwd => {
          const result = runToday(arg, {
            cwd,
            env,
          });

          expect(result.exitCode).toBe(0);
          expect(existsSync(markerPath)).toBe(false);
        });
      });
    });

    test('should still re-exec through dotenvx for normal invocations', () => {
      withFakeNpx(({ markerPath, env }) => {
        withEncryptedEnvDir(cwd => {
          const result = runToday('dry-run --no-sync', { cwd, env });

          expect(result.exitCode).toBe(0);
          expect(existsSync(markerPath)).toBe(true);
        });
      });
    });
  });
});
