import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getQuarter,
  getISOWeek,
  getDateComponents,
  STAGE_MAPPING,
  getStageInfo,
  getDailyPlanPath,
  getPlanFilePath,
  getPlanFileHierarchy,
  walkMarkdownFiles,
  isHighPriority,
  extractTaskDate,
  parseUncompletedTasks,
  getTaskStatistics,
  extractJsonFromResponse,
  getTemplateVariables,
  applyTemplateVariables,
} from '../src/plan-utils.js';

describe('Plan Utils', () => {
  describe('getQuarter', () => {
    test('should return Q1 for months 1-3', () => {
      expect(getQuarter(1)).toBe('Q1');
      expect(getQuarter(2)).toBe('Q1');
      expect(getQuarter(3)).toBe('Q1');
    });

    test('should return Q2 for months 4-6', () => {
      expect(getQuarter(4)).toBe('Q2');
      expect(getQuarter(5)).toBe('Q2');
      expect(getQuarter(6)).toBe('Q2');
    });

    test('should return Q3 for months 7-9', () => {
      expect(getQuarter(7)).toBe('Q3');
      expect(getQuarter(8)).toBe('Q3');
      expect(getQuarter(9)).toBe('Q3');
    });

    test('should return Q4 for months 10-12', () => {
      expect(getQuarter(10)).toBe('Q4');
      expect(getQuarter(11)).toBe('Q4');
      expect(getQuarter(12)).toBe('Q4');
    });
  });

  describe('getISOWeek', () => {
    test('should calculate ISO week correctly', () => {
      // 2025-01-01 is a Wednesday in week 1
      expect(getISOWeek(new Date(2025, 0, 1))).toBe(1);
      // 2025-12-31 is a Wednesday in week 1 of 2026
      expect(getISOWeek(new Date(2025, 11, 31))).toBe(1);
      // 2025-12-07 is in week 49
      expect(getISOWeek(new Date(2025, 11, 7))).toBe(49);
    });

    test('should handle edge cases at year boundaries', () => {
      // Dec 28, 2025 is still week 52 of 2025
      expect(getISOWeek(new Date(2025, 11, 28))).toBe(52);
    });
  });

  describe('getDateComponents', () => {
    test('should return correct components for a date', () => {
      const date = new Date(2025, 11, 7); // Dec 7, 2025
      const components = getDateComponents(date);

      expect(components.year).toBe(2025);
      expect(components.month).toBe(12);
      expect(components.day).toBe(7);
      expect(components.week).toBe(49);
      expect(components.quarter).toBe('Q4');
    });

    test('should handle first day of year', () => {
      const date = new Date(2025, 0, 1);
      const components = getDateComponents(date);

      expect(components.year).toBe(2025);
      expect(components.month).toBe(1);
      expect(components.day).toBe(1);
      expect(components.quarter).toBe('Q1');
    });
  });

  describe('STAGE_MAPPING', () => {
    test('should have all days of the week', () => {
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      for (const day of days) {
        expect(STAGE_MAPPING[day]).toBeDefined();
        expect(STAGE_MAPPING[day]).toHaveLength(2);
      }
    });

    test('should have Front Stage on Monday, Wednesday, Saturday', () => {
      expect(STAGE_MAPPING['Monday'][0]).toBe('Front Stage');
      expect(STAGE_MAPPING['Wednesday'][0]).toBe('Front Stage');
      expect(STAGE_MAPPING['Saturday'][0]).toBe('Front Stage');
    });

    test('should have Back Stage on Thursday, Sunday', () => {
      expect(STAGE_MAPPING['Thursday'][0]).toBe('Back Stage');
      expect(STAGE_MAPPING['Sunday'][0]).toBe('Back Stage');
    });

    test('should have Off Stage on Tuesday, Friday', () => {
      expect(STAGE_MAPPING['Tuesday'][0]).toBe('Off Stage');
      expect(STAGE_MAPPING['Friday'][0]).toBe('Off Stage');
    });
  });

  describe('getStageInfo', () => {
    test('should return stage info for day name string', () => {
      const [stage, focus] = getStageInfo('Monday');
      expect(stage).toBe('Front Stage');
      expect(focus).toContain('Meetings');
    });

    test('should return stage info for Date object', () => {
      // Dec 7, 2025 is a Sunday
      const [stage, focus] = getStageInfo(new Date(2025, 11, 7));
      expect(stage).toBe('Back Stage');
      expect(focus).toContain('Maintenance');
    });

    test('should return Unknown for invalid day', () => {
      const [stage, focus] = getStageInfo('InvalidDay');
      expect(stage).toBe('Unknown');
      expect(focus).toBe('Unknown');
    });
  });

  describe('getDailyPlanPath', () => {
    test('should build correct path from components', () => {
      const components = { year: 2025, month: 12, day: 7, week: 49, quarter: 'Q4' };
      const path = getDailyPlanPath(components);
      expect(path).toBe('vault/plans/2025_Q4_12_W49_07.md');
    });

    test('should pad single digit month, day, and week', () => {
      const components = { year: 2025, month: 1, day: 5, week: 2, quarter: 'Q1' };
      const path = getDailyPlanPath(components);
      expect(path).toBe('vault/plans/2025_Q1_01_W02_05.md');
    });
  });

  describe('getPlanFilePath', () => {
    test('should build path from Date object', () => {
      const date = new Date(2025, 11, 7); // Dec 7, 2025
      const path = getPlanFilePath(date);
      expect(path).toBe('vault/plans/2025_Q4_12_W49_07.md');
    });
  });

  describe('getPlanFileHierarchy', () => {
    test('should return 4 levels of plan files', () => {
      const components = { year: 2025, month: 12, week: 49, quarter: 'Q4' };
      const hierarchy = getPlanFileHierarchy(components);

      expect(hierarchy).toHaveLength(4);
      expect(hierarchy[0].type).toBe('year');
      expect(hierarchy[1].type).toBe('quarter');
      expect(hierarchy[2].type).toBe('month');
      expect(hierarchy[3].type).toBe('week');
    });

    test('should have correct paths for each level', () => {
      const components = { year: 2025, month: 12, week: 49, quarter: 'Q4' };
      const hierarchy = getPlanFileHierarchy(components);

      expect(hierarchy[0].path).toBe('vault/plans/2025_00.md');
      expect(hierarchy[1].path).toBe('vault/plans/2025_Q4_00.md');
      expect(hierarchy[2].path).toBe('vault/plans/2025_Q4_12_00.md');
      expect(hierarchy[3].path).toBe('vault/plans/2025_Q4_12_W49_00.md');
    });

    test('should have descriptive labels', () => {
      const components = { year: 2025, month: 1, week: 2, quarter: 'Q1' };
      const hierarchy = getPlanFileHierarchy(components);

      expect(hierarchy[0].label).toBe('Year plan');
      expect(hierarchy[1].label).toBe('Quarter plan');
      expect(hierarchy[2].label).toBe('Month plan');
      expect(hierarchy[3].label).toBe('Week plan');
    });
  });

  describe('isHighPriority', () => {
    test('should detect 🔺 emoji', () => {
      expect(isHighPriority('- [ ] Important task 🔺')).toBe(true);
    });

    test('should detect ⏫ emoji', () => {
      expect(isHighPriority('- [ ] Urgent task ⏫')).toBe(true);
    });

    test('should detect 🔴 emoji', () => {
      expect(isHighPriority('- [ ] Critical task 🔴')).toBe(true);
    });

    test('should return false for normal tasks', () => {
      expect(isHighPriority('- [ ] Regular task')).toBe(false);
      expect(isHighPriority('- [ ] Task with 📅 2025-01-01')).toBe(false);
    });
  });

  describe('extractTaskDate', () => {
    test('should extract date with 📅 emoji', () => {
      expect(extractTaskDate('- [ ] Task 📅 2025-12-07')).toBe('2025-12-07');
    });

    test('should extract date with ⏳ emoji', () => {
      expect(extractTaskDate('- [ ] Task ⏳ 2025-01-15')).toBe('2025-01-15');
    });

    test('should return null for tasks without dates', () => {
      expect(extractTaskDate('- [ ] Task without date')).toBeNull();
    });

    test('should handle extra whitespace', () => {
      expect(extractTaskDate('- [ ] Task 📅  2025-06-30')).toBe('2025-06-30');
    });
  });

  describe('parseUncompletedTasks', () => {
    test('should parse uncompleted tasks from markdown', () => {
      const content = `# Tasks
- [ ] Uncompleted task 1
- [x] Completed task
- [ ] Uncompleted task 2
Some text
- [ ] Another task`;

      const tasks = parseUncompletedTasks(content);
      expect(tasks).toHaveLength(3);
      expect(tasks[0]).toBe('- [ ] Uncompleted task 1');
      expect(tasks[1]).toBe('- [ ] Uncompleted task 2');
      expect(tasks[2]).toBe('- [ ] Another task');
    });

    test('should return empty array for no tasks', () => {
      const content = '# No tasks here\nJust some text.';
      expect(parseUncompletedTasks(content)).toEqual([]);
    });
  });

  describe('extractJsonFromResponse', () => {
    test('should extract JSON from ```json block', () => {
      const text = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
      expect(extractJsonFromResponse(text)).toEqual({ key: 'value' });
    });

    test('should extract JSON from generic ``` block', () => {
      const text = 'Result:\n```\n{"name": "test"}\n```';
      expect(extractJsonFromResponse(text)).toEqual({ name: 'test' });
    });

    test('should extract raw JSON object', () => {
      const text = 'The answer is {"count": 42} as expected.';
      expect(extractJsonFromResponse(text)).toEqual({ count: 42 });
    });

    test('should parse plain JSON string', () => {
      const text = '{"simple": true}';
      expect(extractJsonFromResponse(text)).toEqual({ simple: true });
    });

    test('should throw on invalid JSON', () => {
      expect(() => extractJsonFromResponse('not json at all')).toThrow();
    });
  });

  describe('getTemplateVariables', () => {
    test('should return all expected template keys', () => {
      const date = new Date(2025, 11, 7); // Sunday, Dec 7, 2025
      const vars = getTemplateVariables(date);

      expect(vars['{{DAY_OF_WEEK}}']).toBe('Sunday');
      expect(vars['{{MONTH_NAME}}']).toBe('December');
      expect(vars['{{DAY}}']).toBe('7');
      expect(vars['{{YEAR}}']).toBe('2025');
      expect(vars['{{FULL_DATE}}']).toBe('December 7, 2025');
      expect(vars['{{STAGE_THEME}}']).toBe('Back Stage');
      expect(vars['{{STAGE_FOCUS}}']).toContain('Maintenance');
    });

    test('should include empty placeholders for time blocks', () => {
      const vars = getTemplateVariables(new Date());

      expect(vars['{{PRIORITIES_FROM_DATABASE}}']).toBe('');
      expect(vars['{{MORNING_TIME_BLOCKS}}']).toBe('');
      expect(vars['{{AFTERNOON_TIME_BLOCKS}}']).toBe('');
      expect(vars['{{EVENING_TIME_BLOCKS}}']).toBe('');
    });
  });

  describe('applyTemplateVariables', () => {
    test('should replace all variables in content', () => {
      const content = 'Hello {{NAME}}, today is {{DAY}}.';
      const vars = { '{{NAME}}': 'World', '{{DAY}}': 'Monday' };

      expect(applyTemplateVariables(content, vars)).toBe('Hello World, today is Monday.');
    });

    test('should handle multiple occurrences', () => {
      const content = '{{X}} + {{X}} = 2{{X}}';
      const vars = { '{{X}}': '1' };

      expect(applyTemplateVariables(content, vars)).toBe('1 + 1 = 21');
    });

    test('should leave unmatched variables unchanged', () => {
      const content = '{{KNOWN}} and {{UNKNOWN}}';
      const vars = { '{{KNOWN}}': 'found' };

      expect(applyTemplateVariables(content, vars)).toBe('found and {{UNKNOWN}}');
    });
  });

  describe('walkMarkdownFiles', () => {
    let testDir;

    beforeEach(() => {
      // Create a temporary test directory structure
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-utils-test-'));

      // Create directory structure
      fs.mkdirSync(path.join(testDir, 'subdir'));
      fs.mkdirSync(path.join(testDir, '.hidden'));
      fs.mkdirSync(path.join(testDir, 'templates'));

      // Create test files
      fs.writeFileSync(path.join(testDir, 'file1.md'), '# File 1');
      fs.writeFileSync(path.join(testDir, 'file2.md'), '# File 2');
      fs.writeFileSync(path.join(testDir, 'file3.txt'), 'Not markdown');
      fs.writeFileSync(path.join(testDir, 'subdir', 'nested.md'), '# Nested');
      fs.writeFileSync(path.join(testDir, '.hidden', 'secret.md'), '# Hidden');
      fs.writeFileSync(path.join(testDir, 'templates', 'template.md'), '# Template');
    });

    afterEach(() => {
      // Clean up temp directory
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    test('should find all markdown files recursively', () => {
      const files = walkMarkdownFiles(testDir);

      expect(files).toHaveLength(3); // file1.md, file2.md, nested.md
      expect(files.some(f => f.endsWith('file1.md'))).toBe(true);
      expect(files.some(f => f.endsWith('file2.md'))).toBe(true);
      expect(files.some(f => f.endsWith('nested.md'))).toBe(true);
    });

    test('should exclude hidden directories by default', () => {
      const files = walkMarkdownFiles(testDir);

      expect(files.some(f => f.includes('.hidden'))).toBe(false);
    });

    test('should exclude templates directory by default', () => {
      const files = walkMarkdownFiles(testDir);

      expect(files.some(f => f.includes('templates'))).toBe(false);
    });

    test('should not include non-markdown files', () => {
      const files = walkMarkdownFiles(testDir);

      expect(files.some(f => f.endsWith('.txt'))).toBe(false);
    });

    test('should return empty array for non-existent directory', () => {
      const files = walkMarkdownFiles('/nonexistent/path');

      expect(files).toEqual([]);
    });

    test('should respect custom excludeDirs option', () => {
      const files = walkMarkdownFiles(testDir, { excludeDirs: ['subdir'] });

      expect(files.some(f => f.includes('subdir'))).toBe(false);
      // Should still find root level files
      expect(files.some(f => f.endsWith('file1.md'))).toBe(true);
    });

    test('should respect custom extension option', () => {
      const files = walkMarkdownFiles(testDir, { extension: '.txt' });

      expect(files).toHaveLength(1);
      expect(files[0]).toContain('file3.txt');
    });
  });

  describe('getTaskStatistics', () => {
    let testDir;

    beforeEach(() => {
      // Create a temporary test vault
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-stats-test-'));

      // Create test markdown files with tasks
      const file1Content = `# Project Tasks
- [ ] Regular task
- [ ] High priority task 🔺
- [x] Completed task
- [ ] Overdue task 📅 2020-01-01
- [ ] Future task 📅 2099-12-31
`;

      const file2Content = `# More Tasks
- [ ] Another task ⏫
- [ ] Scheduled overdue ⏳ 2020-06-15
- [ ] Normal task
`;

      fs.writeFileSync(path.join(testDir, 'project.md'), file1Content);
      fs.writeFileSync(path.join(testDir, 'more.md'), file2Content);
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    test('should count total uncompleted tasks', () => {
      const stats = getTaskStatistics(testDir);

      expect(stats.total).toBe(7); // All uncompleted tasks
    });

    test('should count high priority tasks', () => {
      const stats = getTaskStatistics(testDir);

      expect(stats.highPriority).toBe(2); // 🔺 and ⏫
    });

    test('should count overdue tasks', () => {
      const stats = getTaskStatistics(testDir);

      expect(stats.overdue).toBe(2); // 2020-01-01 and 2020-06-15
    });

    test('should return zeros for empty directory', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-test-'));

      try {
        const stats = getTaskStatistics(emptyDir);

        expect(stats.total).toBe(0);
        expect(stats.highPriority).toBe(0);
        expect(stats.overdue).toBe(0);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    test('should return zeros for non-existent directory', () => {
      const stats = getTaskStatistics('/nonexistent/vault');

      expect(stats.total).toBe(0);
      expect(stats.highPriority).toBe(0);
      expect(stats.overdue).toBe(0);
    });
  });
});
