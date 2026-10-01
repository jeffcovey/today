import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as yaml from 'js-yaml';

import {
  parsePlanFilename,
  readSummary,
  setFrontmatterField,
  listPlanSummaries,
  savePlanSummary,
} from '../src/plan-summaries.js';

describe('parsePlanFilename', () => {
  test('daily plan', () => {
    expect(parsePlanFilename('2026_Q3_09_W39_25.md')).toEqual({
      type: 'day', start: '2026-09-25', end: '2026-09-25', label: 'Friday, September 25, 2026',
    });
  });

  test('weekly plan spans Monday–Sunday', () => {
    expect(parsePlanFilename('2026_Q3_09_W39_00.md')).toMatchObject({
      type: 'week', start: '2026-09-21', end: '2026-09-27',
    });
  });

  test('weekly plan at ISO year boundaries', () => {
    // 2026-W01 starts Mon 2025-12-29, filed under December 2025
    expect(parsePlanFilename('2025_Q4_12_W01_00.md')).toMatchObject({ start: '2025-12-29', end: '2026-01-04' });
    // 2026-W53 runs into January 2027
    expect(parsePlanFilename('2027_Q1_01_W53_00.md')).toMatchObject({ start: '2026-12-28', end: '2027-01-03' });
  });

  test('month, quarter and year plans', () => {
    expect(parsePlanFilename('2026_Q3_09_00.md')).toMatchObject({ type: 'month', start: '2026-09-01', end: '2026-09-30' });
    expect(parsePlanFilename('2026_Q3_00.md')).toMatchObject({ type: 'quarter', start: '2026-07-01', end: '2026-09-30' });
    expect(parsePlanFilename('2026_00.md')).toMatchObject({ type: 'year', start: '2026-01-01', end: '2026-12-31' });
  });

  test('rejects non-plan files', () => {
    expect(parsePlanFilename('templates')).toBeNull();
    expect(parsePlanFilename('notes.md')).toBeNull();
    expect(parsePlanFilename('2026_Q3_09_W39_25.md.bak')).toBeNull();
  });
});

describe('readSummary', () => {
  test('blank, missing and placeholder summaries read as empty', () => {
    expect(readSummary('---\ndaily_summary:\n---\n', 'daily_summary')).toBe('');
    expect(readSummary('---\nother: x\n---\n', 'daily_summary')).toBe('');
    expect(readSummary('# no frontmatter', 'daily_summary')).toBe('');
    expect(readSummary('---\nweek_summary: No daily summaries available for this week\n---\n', 'week_summary')).toBe('');
  });

  test('reads a filled summary', () => {
    expect(readSummary('---\ndaily_summary: "A good day."\n---\n', 'daily_summary')).toBe('A good day.');
  });
});

describe('setFrontmatterField', () => {
  const doc = '---\ncssclasses: plan\ndaily_summary:\nobsidianUIMode: preview\n---\n\n# Body\n';

  test('fills a blank field and leaves the rest untouched', () => {
    const out = setFrontmatterField(doc, 'daily_summary', 'He said "hi": then left.\nSecond line.');
    expect(out).toBe('---\ncssclasses: plan\ndaily_summary: "He said \\"hi\\": then left.\\nSecond line."\nobsidianUIMode: preview\n---\n\n# Body\n');
    const fm = yaml.load(out.split('---\n')[1]);
    expect(fm.daily_summary).toBe('He said "hi": then left.\nSecond line.');
  });

  test('updates CRLF frontmatter without adding a second block', () => {
    const crlfDoc = '---\r\ncssclasses: plan\r\ndaily_summary:\r\nobsidianUIMode: preview\r\n---\r\n\r\n# Body\r\n';
    const out = setFrontmatterField(crlfDoc, 'daily_summary', 'A good day.');
    expect(out).toBe('---\r\ncssclasses: plan\r\ndaily_summary: "A good day."\r\nobsidianUIMode: preview\r\n---\r\n\r\n# Body\r\n');
    expect(out.match(/^---/gm)).toHaveLength(2);
    expect(readSummary(out, 'daily_summary')).toBe('A good day.');
  });

  test('replaces a multi-line block value', () => {
    const multi = '---\nweek_summary: >\n  folded line one\n  folded line two\nnext: 1\n---\nbody';
    expect(setFrontmatterField(multi, 'week_summary', 'new')).toBe('---\nweek_summary: "new"\nnext: 1\n---\nbody');
  });

  test('clearing writes an empty field', () => {
    const filled = '---\ndaily_summary: "x"\n---\n';
    expect(setFrontmatterField(filled, 'daily_summary', '')).toBe('---\ndaily_summary:\n---\n');
  });

  test('adds a missing field, and frontmatter when absent', () => {
    expect(setFrontmatterField('---\na: 1\n---\nbody', 'daily_summary', 'x')).toBe('---\na: 1\ndaily_summary: "x"\n---\nbody');
    expect(setFrontmatterField('body', 'daily_summary', 'x')).toBe('---\ndaily_summary: "x"\n---\nbody');
  });

  test('does not match a field that merely shares a prefix', () => {
    const out = setFrontmatterField('---\ndaily_summary_old: keep\ndaily_summary:\n---\n', 'daily_summary', 'x');
    expect(out).toBe('---\ndaily_summary_old: keep\ndaily_summary: "x"\n---\n');
  });
});

describe('listPlanSummaries / savePlanSummary (real git repo)', () => {
  let vault;
  // Strip GIT_DIR/GIT_INDEX_FILE etc.: when jest runs from a git hook they
  // point at the real repo, and the fixture repo's init/commit would land there.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (args) => execFileSync('git', args, { cwd: vault, encoding: 'utf8', env: gitEnv });
  const write = (name, content) => fs.writeFileSync(path.join(vault, 'plans', name), content);
  const daily = (summary) => `---\ncssclasses: plan\ndaily_summary:${summary ? ` "${summary}"` : ''}\n---\n\n- [ ] task\n`;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-summaries-'));
    fs.mkdirSync(path.join(vault, 'plans', 'templates'), { recursive: true });
    git(['init', '-q']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 'T']);

    write('2026_Q3_09_W39_21.md', daily(''));               // committed, blank → listed
    write('2026_Q3_09_W39_22.md', daily('Done.'));          // committed with summary → closed
    write('2026_Q3_09_W39_23.md', daily('Done.'));          // summary edited below → listed
    write('2026_Q3_09_W39_24.md', daily('Done.'));          // task edited below → closed
    write('2026_Q3_08_W33_10.md', daily(''));               // outside the window
    write('2026_Q4_10_W40_01.md', daily(''));               // today: in progress → listed
    write('2026_Q4_10_W40_02.md', daily(''));               // tomorrow: not started
    write('2026_Q3_09_00.md', '---\nmonth_summary:\n---\n'); // month ended 9/30
    write('2026_00.md', '---\nyear_summary:\n---\n');       // year in progress → listed
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);

    write('2026_Q3_09_W39_23.md', daily('AI wrote this.'));
    write('2026_Q3_09_W39_24.md', daily('Done.').replace('[ ]', '[x]'));
    write('2026_Q3_09_W39_25.md', daily('Untracked AI summary.'));
  });

  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  const list = () => listPlanSummaries({ vaultPath: vault, today: '2026-10-01', gitExec: git });

  test('lists blank and uncommitted summaries in the window, including in-progress plans', () => {
    expect(list().map((p) => [p.file, p.status, p.inProgress])).toEqual([
      ['plans/2026_00.md', 'blank', true],
      ['plans/2026_Q3_09_00.md', 'blank', false],
      ['plans/2026_Q4_10_W40_01.md', 'blank', true],
      ['plans/2026_Q3_09_W39_25.md', 'uncommitted', false],
      ['plans/2026_Q3_09_W39_23.md', 'uncommitted', false],
      ['plans/2026_Q3_09_W39_21.md', 'blank', false],
    ]);
  });

  test('a saved summary stays listed until committed', () => {
    const result = savePlanSummary({ vaultPath: vault, file: 'plans/2026_Q3_09_W39_21.md', summary: '  Rested.\r\n' });
    expect(result).toEqual({ file: 'plans/2026_Q3_09_W39_21.md', summary: 'Rested.', status: 'uncommitted' });
    expect(fs.readFileSync(path.join(vault, 'plans/2026_Q3_09_W39_21.md'), 'utf8')).toContain('daily_summary: "Rested."\n');

    expect(list().find((p) => p.file.endsWith('_21.md'))).toMatchObject({ status: 'uncommitted', summary: 'Rested.' });

    git(['commit', '-qam', 'summary']);
    expect(list().find((p) => p.file.endsWith('_21.md'))).toBeUndefined();
  });

  test('rejects paths that are not plan files', () => {
    expect(() => savePlanSummary({ vaultPath: vault, file: '../etc/passwd', summary: 'x' })).toThrow('Not a plan file');
    expect(() => savePlanSummary({ vaultPath: vault, file: 'plans/../2026_00.md', summary: 'x' })).toThrow('Not a plan file');
    expect(() => savePlanSummary({ vaultPath: vault, file: 'plans/2026_Q3_09_W39_29.md', summary: 'x' })).toThrow('not found');
  });
});
