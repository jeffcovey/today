import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import {
  liftRoleBlocks,
  appendBlocksToPlan,
  planMigration,
  applyMigrationMoves,
  dropStaleDiaryRows,
  isInvokedDirectly
} from '../plugins/roles/migrate-diary-to-plans.js';
import { getDailyPlanRelativePath } from '../src/plan-utils.js';
import { minimalDailyPlan, rolePlanDirectory, rolePlanFile, todayPlanRelativePath } from '../plugins/roles/plan-file.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'plugins', 'roles', 'migrate-diary-to-plans.js');

const BLOCK = [
  '<!-- ROLE:secretary:START -->',
  '## 🤖 Secretary',
  '',
  '### 04:07',
  '',
  '**Birthday Friday.**',
  '',
  '- [-] → Jeff: Send a greeting',
  '',
  '-> secretary: Drop this.',
  '',
  '<!-- ROLE:secretary:END -->',
  ''
].join('\n');

const DIARY = [
  '---',
  'date: 2026-10-13',
  '---',
  '',
  '## Journal',
  '',
  '### 21:00',
  '',
  'A real diary line.',
  '',
  BLOCK,
  '',
  '<!-- ROLE:cpa:START -->',
  '## 🤖 CPA',
  '',
  '### 04:08',
  '',
  'Books balanced.',
  '<!-- ROLE:cpa:END -->',
  ''
].join('\n');

const PLAN = '---\ncssclasses: plan\n---\n\n# Daily Plan - Tuesday, October 13, 2026\n\n## 📋 Top Priorities\n\n- [ ] Walk!\n';

function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('DOTENV')));
  return { ...env, ...extra };
}

describe('plan-file helpers', () => {
  test('daily plan paths follow the plans naming scheme, independent of the zone', () => {
    expect(getDailyPlanRelativePath('2026-10-16')).toBe('plans/2026_Q4_10_W42_16.md');
    expect(getDailyPlanRelativePath('2026-10-11')).toBe('plans/2026_Q4_10_W41_11.md');
    expect(getDailyPlanRelativePath('2026-01-01')).toBe('plans/2026_Q1_01_W01_01.md');
    expect(() => getDailyPlanRelativePath('16/10/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => getDailyPlanRelativePath('2026-02-31')).toThrow(/real calendar date/);
    expect(rolePlanFile('/v', '2026-10-16')).toBe('/v/plans/2026_Q4_10_W42_16.md');
  });

  test('role paths use the enabled markdown-plans directory setting', () => {
    const configured = path.join(os.tmpdir(), 'custom-plans');
    const config = { plugins: { 'markdown-plans': { default: { enabled: true, plans_directory: configured } } } };
    expect(rolePlanDirectory('/v', config)).toBe(configured);
    expect(rolePlanFile('/v', '2026-10-16', config)).toBe(path.join(configured, '2026_Q4_10_W42_16.md'));
    expect(todayPlanRelativePath(new Date('2026-10-16T12:00:00Z'), '/v', {
      plugins: { 'markdown-plans': { default: { enabled: true, plans_directory: path.join('/v', 'custom') } } }
    })).toBe('custom/2026_Q4_10_W42_16.md');
  });

  test("today's plan path follows the configured zone", () => {
    const saved = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      expect(todayPlanRelativePath(new Date('2026-10-13T02:00:00Z'))).toBe('plans/2026_Q4_10_W42_12.md');
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });

  test('a minimal daily plan has front matter the plans plugin accepts and the usual title', () => {
    const content = minimalDailyPlan('2026-10-16');
    expect(content.startsWith('---\ncssclasses: plan\n')).toBe(true);
    expect(content).toContain('# Daily Plan - Friday, October 16, 2026');
  });
});

describe('liftRoleBlocks / appendBlocksToPlan', () => {
  test('lifts every block verbatim without normalizing unrelated diary content', () => {
    const { blocks, remainder } = liftRoleBlocks(DIARY);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(BLOCK);
    expect(blocks[1]).toContain('Books balanced.');
    expect(remainder).toContain('A real diary line.');
    expect(remainder).not.toContain('ROLE:');
    const preserved = '## Journal\n\n### 21:00\n\nA real diary line.\n\n';
    expect(remainder).toContain(preserved);
  });

  test('lifts CRLF role blocks and preserves blank lines outside them', () => {
    const crlfBlock = BLOCK.replace(/\n/g, '\r\n');
    const source = `## Journal\r\n\r\n\`\`\`text\r\n\r\n\r\n\`\`\`\r\n\r\n${crlfBlock}`;
    const { blocks, remainder } = liftRoleBlocks(source);
    expect(blocks).toEqual([crlfBlock]);
    expect(remainder).toBe('## Journal\r\n\r\n```text\r\n\r\n\r\n```\r\n\r\n');
  });

  test('appends blocks at the end of the plan, one blank line apart', () => {
    const { blocks } = liftRoleBlocks(DIARY);
    const after = appendBlocksToPlan(PLAN, blocks);
    expect(after.startsWith(PLAN.trimEnd() + '\n\n<!-- ROLE:secretary:START -->')).toBe(true);
    expect(after).toContain('<!-- ROLE:secretary:END -->\n\n<!-- ROLE:cpa:START -->');
    expect(after.endsWith('<!-- ROLE:cpa:END -->\n')).toBe(true);
  });

  test('merges an older overlapping diary block before the plan entries, preserving replies and retry safety', () => {
    const current = [
      PLAN.trimEnd(),
      '<!-- ROLE:secretary:START -->',
      '## 🤖 Secretary',
      '',
      '### 05:00',
      '',
      'New plan entry.',
      '',
      '-> secretary: Keep this.',
      '<!-- ROLE:secretary:END -->',
      ''
    ].join('\n');
    const merged = appendBlocksToPlan(current, [BLOCK]);
    expect(merged.match(/<!-- ROLE:secretary:START -->/g)).toHaveLength(1);
    expect(merged.match(/<!-- ROLE:secretary:END -->/g)).toHaveLength(1);
    expect(merged.indexOf('### 04:07')).toBeLessThan(merged.indexOf('### 05:00'));
    expect(merged).toContain('-> secretary: Drop this.');
    expect(merged).toContain('-> secretary: Keep this.');
    expect(appendBlocksToPlan(merged, [BLOCK])).toBe(merged);
  });

  test('direct invocation comparison decodes escaped file URLs', () => {
    expect(isInvokedDirectly('/tmp/a b/migrate.js', 'file:///tmp/a%20b/migrate.js')).toBe(true);
  });
});

describe('migration', () => {
  let vault;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-migration-'));
    fs.mkdirSync(path.join(vault, 'diary'));
    fs.mkdirSync(path.join(vault, 'plans'));
    fs.writeFileSync(path.join(vault, 'diary', '2026-10-13.md'), DIARY);
    fs.writeFileSync(path.join(vault, 'diary', '2026-10-14.md'), '## Journal\n\nNo roles here.\n');
    fs.writeFileSync(path.join(vault, 'diary', '2026-10-15.md'), '## Journal\n\n' + BLOCK);
    fs.writeFileSync(path.join(vault, getDailyPlanRelativePath('2026-10-13')), PLAN);
    // No plan file for 2026-10-15.
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test('planMigration computes every move without writing', () => {
    const before = fs.readFileSync(path.join(vault, 'diary', '2026-10-13.md'), 'utf8');
    const moves = planMigration(vault);

    expect(moves.map((m) => [m.date, m.roles, m.planExists])).toEqual([
      ['2026-10-13', ['secretary', 'cpa'], true],
      ['2026-10-15', ['secretary'], false]
    ]);
    expect(moves[1].planAfter.startsWith(minimalDailyPlan('2026-10-15'))).toBe(true);
    expect(fs.readFileSync(path.join(vault, 'diary', '2026-10-13.md'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(vault, getDailyPlanRelativePath('2026-10-15')))).toBe(false);
  });

  test.each(['diary', 'plan'])('write aborts and preserves both files when the %s snapshot changed', (changedFile) => {
    const moves = planMigration(vault);
    const diaryPath = path.join(vault, 'diary', '2026-10-13.md');
    const planPath = path.join(vault, getDailyPlanRelativePath('2026-10-13'));
    const changedDiary = `${DIARY}\nUser edit.\n`;
    const changedPlan = `${PLAN}\nUser edit.\n`;
    if (changedFile === 'diary') fs.writeFileSync(diaryPath, changedDiary);
    else fs.writeFileSync(planPath, changedPlan);
    const beforeDiary = fs.readFileSync(diaryPath, 'utf8');
    const beforePlan = fs.readFileSync(planPath, 'utf8');
    expect(() => applyMigrationMoves([moves[0]])).toThrow(/Migration conflict/);
    expect(fs.readFileSync(planPath, 'utf8')).toBe(beforePlan);
    expect(fs.readFileSync(diaryPath, 'utf8')).toBe(beforeDiary);
  });

  test('planMigration targets the configured plans directory', () => {
    const customPlans = path.join(vault, 'custom-plans');
    const moves = planMigration(vault, customPlans);
    expect(moves[0].planPath).toBe(path.join(customPlans, '2026_Q4_10_W42_13.md'));
  });

  function run(...args) {
    const configPath = path.join(vault, 'config.toml');
    fs.writeFileSync(configPath, [
      `vault_path = ${JSON.stringify(path.relative(REPO_ROOT, vault))}`,
      'timezone = "UTC"',
      ''
    ].join('\n'));
    return spawnSync(process.execPath, [SCRIPT, ...args], { env: cleanEnv({ TODAY_CONFIG: configPath }), encoding: 'utf8' });
  }

  test('the dry run prints diffs and touches nothing in the vault', () => {
    const out = path.join(vault, 'proposed');
    const result = run('--out', out);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--- diary/2026-10-13.md (now)');
    expect(result.stdout).toContain('+++ plans/2026_Q4_10_W42_13.md (after)');
    expect(result.stdout).toContain('2 diary files would move 3 role blocks');
    expect(result.stdout).toContain('(new file)');
    expect(fs.readFileSync(path.join(vault, 'diary', '2026-10-13.md'), 'utf8')).toBe(DIARY);
    expect(fs.readFileSync(path.join(vault, getDailyPlanRelativePath('2026-10-13')), 'utf8')).toBe(PLAN);
    expect(fs.existsSync(path.join(vault, getDailyPlanRelativePath('2026-10-15')))).toBe(false);
  });

  test('--write moves the blocks and leaves everything else as it was', () => {
    const result = run('--write', '--no-db');
    expect(result.status).toBe(0);

    const diary = fs.readFileSync(path.join(vault, 'diary', '2026-10-13.md'), 'utf8');
    expect(diary).not.toContain('ROLE:');
    expect(diary).toContain('A real diary line.');
    const plan = fs.readFileSync(path.join(vault, getDailyPlanRelativePath('2026-10-13')), 'utf8');
    expect(plan.startsWith(PLAN.trimEnd())).toBe(true);
    expect(plan).toContain('-> secretary: Drop this.');
    expect(plan).toContain('Books balanced.');
    const created = fs.readFileSync(path.join(vault, getDailyPlanRelativePath('2026-10-15')), 'utf8');
    expect(created).toContain('# Daily Plan - Thursday, October 15, 2026');
    expect(created).toContain('<!-- ROLE:secretary:START -->');
    expect(fs.readFileSync(path.join(vault, 'diary', '2026-10-14.md'), 'utf8')).toBe('## Journal\n\nNo roles here.\n');

    expect(run('--write', '--no-db').stdout).toContain('nothing to move');
  });

  test('dropStaleDiaryRows removes only cached role rows for the moved dates', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE diary (id TEXT, source TEXT, date TEXT, text TEXT, metadata TEXT)');
    const insert = db.prepare('INSERT INTO diary VALUES (?, ?, ?, ?, ?)');
    insert.run('a', 'markdown-diary/default', '2026-10-13T04:07:00', 'role entry', '{"type":"role","role":"secretary"}');
    insert.run('b', 'markdown-diary/default', '2026-10-13T21:00:00', 'journal entry', '{"type":"journal"}');
    insert.run('c', 'markdown-diary/default', '2026-10-14T04:07:00', 'role entry other day', '{"type":"role","role":"cpa"}');
    insert.run('d', 'dayone-diary/default', '2026-10-13T04:07:00', 'dayone', '{"type":"role"}');

    expect(dropStaleDiaryRows(db, ['2026-10-13'])).toBe(1);
    expect(db.prepare('SELECT id FROM diary ORDER BY id').all().map((r) => r.id)).toEqual(['b', 'c', 'd']);
  });
});
