import {
  buildTasksQueryContext,
  runTasksFilterFunction,
  runTasksGroupFunction
} from '../src/tasks-query-functions.js';

describe('tasks query function helpers', () => {
  test('supports Obsidian-style filter by function statements', () => {
    const filterCode = 'const match = task.file.filename.match(/(\\d{4})_Q\\d+_(\\d{2})_W\\d+_(\\d{2})\\.md/); if (!match) return false; const fileDate = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3])); const today = new Date(); today.setHours(0, 0, 0, 0); return fileDate <= today;';

    const eligibleTask = { file: { filename: '2000_Q1_01_W1_01.md' } };
    const futureTask = { file: { filename: '2999_Q1_01_W1_01.md' } };
    const invalidTask = { file: { filename: 'notes.md' } };

    expect(runTasksFilterFunction(eligibleTask, filterCode)).toBe(true);
    expect(runTasksFilterFunction(futureTask, filterCode)).toBe(false);
    expect(runTasksFilterFunction(invalidTask, filterCode)).toBe(false);
  });

  test('supports Obsidian-style group by function expressions', () => {
    const task = { file: { path: 'plans/2026_Q2_05_W4_27.md' } };
    const groupExpr = "task.file.path.toUpperCase().replace(query.file.folder, ': ')";
    const query = { file: { folder: 'PLANS/' } };

    expect(runTasksGroupFunction(task, groupExpr, query)).toBe(': 2026_Q2_05_W4_27.MD');
  });

  test('buildTasksQueryContext sets query file folder from URL path', () => {
    expect(buildTasksQueryContext('/tasks/plans.md')).toEqual({ file: { folder: 'tasks' } });
    expect(buildTasksQueryContext('/plans.md')).toEqual({ file: { folder: '' } });
  });
});
