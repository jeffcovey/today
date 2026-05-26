/**
 * End-to-end smoke tests for plugins/markdown-tasks/write.js
 *
 * These tests spawn the plugin script as a child process and verify it still
 * does the right thing after the fs-atomic / CAS refactor. They cover the
 * happy paths — add, complete, update, archive-completed — and confirm the
 * new conflict-aware response shape (files_skipped_due_to_conflict on batch
 * actions).
 *
 * True race-condition coverage lives in test/fs-atomic.test.js where the
 * primitive can be exercised directly.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const WRITE_SCRIPT = path.join(REPO_ROOT, 'plugins/markdown-tasks/write.js');
const RELATIVE_TASKS_PATH = 'tasks/tasks.md';

// The plugin joins PROJECT_ROOT with the relative default_task_file path, so
// the runner points PROJECT_ROOT at the per-test temp vault and uses a
// relative task path inside it.
function runWrite(entry, { vaultPath, config = {} } = {}) {
  const env = {
    ...process.env,
    PROJECT_ROOT: vaultPath,
    VAULT_PATH: vaultPath,
    PLUGIN_CONFIG: JSON.stringify({
      directory: 'tasks',
      default_task_file: RELATIVE_TASKS_PATH,
      ...config,
    }),
    ENTRY_JSON: JSON.stringify(entry),
  };
  let stdout;
  try {
    stdout = execFileSync('node', [WRITE_SCRIPT], { env, encoding: 'utf8' });
  } catch (err) {
    // The script exits non-zero on logical failure but still writes JSON to
    // stdout; surface that to the test.
    stdout = err.stdout || '';
    if (!stdout) throw err;
  }
  return JSON.parse(stdout);
}

describe('markdown-tasks/write.js (fs-atomic rollout)', () => {
  let vaultPath;
  let tasksFile;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'md-tasks-write-'));
    tasksFile = path.join(vaultPath, RELATIVE_TASKS_PATH);
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  test('add creates the file and appends a task line', () => {
    const result = runWrite({ action: 'add', title: 'Write a postcard' }, { vaultPath });

    expect(result.success).toBe(true);
    expect(result.action).toBe('add');
    expect(result.line).toMatch(/^- \[ \] Write a postcard/);

    const onDisk = fs.readFileSync(tasksFile, 'utf8');
    expect(onDisk).toContain('- [ ] Write a postcard');
  });

  test('two sequential adds preserve both tasks (no clobber, no temp leftover)', () => {
    runWrite({ action: 'add', title: 'First task' }, { vaultPath });
    runWrite({ action: 'add', title: 'Second task' }, { vaultPath });

    const onDisk = fs.readFileSync(tasksFile, 'utf8');
    expect(onDisk).toContain('- [ ] First task');
    expect(onDisk).toContain('- [ ] Second task');

    const leftovers = fs.readdirSync(path.dirname(tasksFile)).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  test('complete marks an existing task done and reports line metadata', () => {
    runWrite({ action: 'add', title: 'Finish the proposal' }, { vaultPath });

    const result = runWrite(
      { action: 'complete', id: `${RELATIVE_TASKS_PATH}:1`, title: 'Finish the proposal' },
      { vaultPath }
    );

    expect(result.success).toBe(true);
    expect(result.new_line).toMatch(/^- \[x\] Finish the proposal/);
    expect(fs.readFileSync(tasksFile, 'utf8')).toMatch(/- \[x\] Finish the proposal/);
  });

  test('update changes due_date on an existing task', () => {
    runWrite({ action: 'add', title: 'Pay rent' }, { vaultPath });

    const result = runWrite(
      { action: 'update', id: `${RELATIVE_TASKS_PATH}:1`, due_date: '2099-01-15' },
      { vaultPath }
    );

    expect(result.success).toBe(true);
    expect(result.new_line).toContain('📅 2099-01-15');
    expect(fs.readFileSync(tasksFile, 'utf8')).toContain('📅 2099-01-15');
  });

  test('archive-completed surfaces the conflict-tracking field even on a clean run', () => {
    runWrite({ action: 'add', title: 'Old task' }, { vaultPath });
    runWrite(
      { action: 'complete', id: `${RELATIVE_TASKS_PATH}:1`, title: 'Old task' },
      { vaultPath }
    );

    const result = runWrite({ action: 'archive-completed' }, { vaultPath });

    expect(result.success).toBe(true);
    expect(result.archived).toBe(1);
    // New field added by the rollout — present even when nothing conflicted.
    expect(Array.isArray(result.files_skipped_due_to_conflict)).toBe(true);
  });

  // Regression coverage for #289 — the rebalance used to auto-consolidate
  // every numbered file into the main file whenever total tasks fit there,
  // silently deleting tasks-1.md (and other numbered siblings) multiple
  // times a day on busy vaults. It also did the deletion via an unguarded
  // fs.unlinkSync before writing the new distribution, leaving a window
  // where a crash mid-rebalance lost the deleted content entirely.
  test('archive-completed does NOT delete tasks-1.md when underflow could consolidate', () => {
    // Set up: main file has 1 task, tasks-1.md has 1 task. Together they
    // fit easily inside the default max_tasks_per_file (50), so the old
    // code would have consolidated and deleted tasks-1.md.
    fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
    fs.writeFileSync(tasksFile, '- [ ] Main task\n');
    const overflowPath = path.join(path.dirname(tasksFile), 'tasks-1.md');
    fs.writeFileSync(overflowPath, '- [ ] Overflow task\n');

    const result = runWrite({ action: 'archive-completed' }, { vaultPath });

    expect(result.success).toBe(true);
    expect(result.rebalanced).toBe(false);
    expect(fs.existsSync(overflowPath)).toBe(true);
    expect(fs.readFileSync(overflowPath, 'utf8')).toContain('- [ ] Overflow task');
  });

  test('archive-completed splits forward when main file overflows', () => {
    fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
    // 5 tasks with max_tasks_per_file = 2 => 3 files needed (main + 2 numbered).
    const overflowTasks = Array.from({ length: 5 }, (_, i) => `- [ ] Task ${i + 1}`).join('\n') + '\n';
    fs.writeFileSync(tasksFile, overflowTasks);

    const result = runWrite(
      { action: 'archive-completed', max_tasks_per_file: 2 },
      { vaultPath }
    );

    expect(result.success).toBe(true);
    expect(result.rebalanced).toBe(true);

    // Main file and at least one new numbered file should now exist, and
    // every file should be within the max.
    const tasksDir = path.dirname(tasksFile);
    const taskFiles = fs.readdirSync(tasksDir).filter(f => /^tasks(-\d+)?\.md$/.test(f));
    expect(taskFiles.length).toBeGreaterThanOrEqual(2);
    for (const f of taskFiles) {
      const lineCount = fs.readFileSync(path.join(tasksDir, f), 'utf8').split('\n').filter(line => line.trim()).length;
      expect(lineCount).toBeLessThanOrEqual(2);
    }

    // No backup files left over after a successful rebalance.
    const backups = fs.readdirSync(tasksDir).filter(f => f.includes('.rebalance-bak-'));
    expect(backups).toEqual([]);
  });

  test('archive-completed preserves existing numbered files when no overflow', () => {
    // Pre-create an empty tasks-1.md — a no-overflow run should leave it
    // alone rather than deleting it.
    fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
    fs.writeFileSync(tasksFile, '- [ ] Single task\n');
    const overflowPath = path.join(path.dirname(tasksFile), 'tasks-1.md');
    fs.writeFileSync(overflowPath, '');

    const result = runWrite({ action: 'archive-completed' }, { vaultPath });

    expect(result.success).toBe(true);
    expect(fs.existsSync(overflowPath)).toBe(true);
  });
});
