import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sourceConfig = { enabled: true, auto_archive_completed: true, default_task_file: 'tasks/tasks.md' };
const writePluginEntry = jest.fn();

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: () => ({ plugins: { 'markdown-tasks': { local: sourceConfig } } }),
  getTimezone: () => 'UTC',
  getVaultPath: () => 'vault'
}));
jest.unstable_mockModule('../src/plugin-loader.js', () => ({
  writePluginEntry,
  tryAcquireSyncLock: () => null,
  releaseSyncLock: jest.fn()
}));
jest.unstable_mockModule('../src/database-service.js', () => ({
  getDatabase: () => ({})
}));

const { runNightlyTaskMaintenance } = await import('../src/task-nightly.js');

describe('nightly task maintenance state', () => {
  let projectRoot;
  let taskFile;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-nightly-'));
    taskFile = path.join(projectRoot, sourceConfig.default_task_file);
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    fs.writeFileSync(taskFile, '- [ ] Alpha\n');
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(taskFile, old, old);
    writePluginEntry.mockReset();
  });

  afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  test('does not mark the night complete when writes were skipped on conflict', async () => {
    writePluginEntry.mockResolvedValue({
      success: true,
      data: { files_skipped_due_to_conflict: ['tasks/tasks.md'] }
    });

    const options = { projectRoot, now: new Date(), force: true, log: jest.fn() };
    const first = await runNightlyTaskMaintenance(options);
    const second = await runNightlyTaskMaintenance(options);

    expect(first.ran).toEqual([]);
    expect(second.ran).toEqual([]);
    expect(writePluginEntry).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(projectRoot, '.data', 'task-nightly-state.json'))).toBe(false);
  });
});
