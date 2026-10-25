import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTasks, readTasks, withLazyTasks } from '../src/dataview-tasks.js';
import { buildFileRecord } from '../src/vault-file-index.js';

describe('parseTasks', () => {
  test('reads open, done, cancelled and blockquoted tasks', () => {
    const tasks = parseTasks([
      '- [ ] open one',
      '- [x] done one ✅ 2026-10-20',
      '- [-] dropped',
      '> - [X] quoted done',
      'not a task'
    ].join('\n'));

    expect(tasks.map(t => [t.text, t.status])).toEqual([
      ['open one', 'open'],
      ['done one ✅ 2026-10-20', 'done'],
      ['dropped', 'cancelled'],
      ['quoted done', 'done']
    ]);
  });
});

describe('withLazyTasks', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-tasks-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('gives an index record file.tasks, read once on first access', () => {
    const fullPath = path.join(dir, 'project.md');
    fs.writeFileSync(fullPath, '- [x] shipped ✅ 2026-10-21\n- [ ] next\n');
    const record = buildFileRecord('projects/project.md', { status: 'active' });

    let wraps = 0;
    const page = withLazyTasks(record, fullPath, tasks => { wraps++; return tasks; });

    expect(wraps).toBe(0);
    expect(page.file.tasks.filter(t => t.completed).map(t => t.text)).toEqual(['shipped ✅ 2026-10-21']);
    expect(page.file.tasks).toBe(page.file.tasks);
    expect(wraps).toBe(1);
    expect(page.file.path).toBe('projects/project.md');
    expect(page.status).toBe('active');
    expect(record.file.tasks).toBeUndefined();
  });

  test('a missing file has no tasks rather than throwing', () => {
    expect(readTasks(path.join(dir, 'gone.md'))).toEqual([]);
    const page = withLazyTasks(buildFileRecord('projects/gone.md', {}), path.join(dir, 'gone.md'));
    expect(page.file.tasks).toEqual([]);
  });
});
