import { execSync } from 'child_process';
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
      },
      ...options,
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

describe('bin/today CLI', () => {
  describe('--help', () => {
    test('should display help message', () => {
      const result = runToday('--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Today - Daily review and planning tool');
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('Commands:');
      expect(result.stdout).toContain('Options:');
    });

    test('should show all available commands', () => {
      const result = runToday('--help');

      expect(result.stdout).toContain('init');
      expect(result.stdout).toContain('update');
      expect(result.stdout).toContain('dry-run');
    });

    test('should show --no-sync option', () => {
      const result = runToday('--help');

      expect(result.stdout).toContain('--no-sync');
    });

    test('-h should also show help', () => {
      const result = runToday('-h');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Today - Daily review and planning tool');
    });
  });

  describe('init', () => {
    test('should initialize review file hierarchy', () => {
      const result = runToday('init');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Initializing review file hierarchy');
      expect(result.stdout).toContain('Review hierarchy is ready');
    });
  });

  describe('dry-run', () => {
    test('should run without making changes', () => {
      const result = runToday('dry-run --no-sync');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('dry-run mode');
      expect(result.stdout).toContain('Dry run complete');
    });

    test('should check time tracking widgets', () => {
      const result = runToday('dry-run --no-sync');

      expect(result.stdout).toContain('Checking time tracking widgets');
    });

    test('should show proposed changes without applying', () => {
      const result = runToday('dry-run --no-sync');

      // Should mention it's a dry run
      expect(result.stdout.toLowerCase()).toContain('dry run');
      // Should not actually write files (no "Updated" messages)
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
    test('should reference correct plan file format in help', () => {
      const result = runToday('--help');

      // Should mention the file naming convention
      expect(result.stdout).toContain('YYYY_QQ_MM_W##_DD.md');
    });

    test('dry-run should show today\'s plan path', () => {
      const result = runToday('dry-run --no-sync');

      // Should reference a plan file with the expected format
      expect(result.stdout).toMatch(/vault\/plans\/\d{4}_Q\d_\d{2}_W\d{2}_\d{2}\.md/);
    });
  });

  describe('error handling', () => {
    test('should handle unknown commands gracefully', () => {
      const result = runToday('unknown-command');

      // Should either show help or an error, not crash
      expect(result.stdout + (result.stderr || '')).toBeTruthy();
    });
  });
});
