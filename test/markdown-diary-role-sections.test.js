import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const readScript = path.join(repoRoot, 'plugins', 'markdown-diary', 'read.js');

function todayDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function runReadPlugin(projectRoot) {
  const result = spawnSync('node', [readScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TZ: 'America/New_York',
      PROJECT_ROOT: projectRoot,
      VAULT_PATH: path.join(projectRoot, 'vault'),
      SOURCE_ID: 'markdown-diary/test',
      LAST_SYNC_TIME: '',
      PLUGIN_CONFIG: JSON.stringify({ diary_directory: 'vault/diary' })
    }
  });
  const output = (result.stdout || '').trim();
  return JSON.parse(output.split('\n').pop());
}

describe('markdown-diary ROLE sections', () => {
  let tempRoot;
  let diaryDir;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-diary-roles-'));
    diaryDir = path.join(tempRoot, 'vault', 'diary');
    fs.mkdirSync(diaryDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeDiary(date, body) {
    const content = `---\ndate: ${date}\n---\n\n${body}`;
    fs.writeFileSync(path.join(diaryDir, `${date}.md`), content);
  }

  test('parses ROLE block entries with role metadata', () => {
    writeDiary('2026-10-01', [
      '<!-- ROLE:cpa:START -->',
      '## 🤖 CPA',
      '',
      '### 14:05',
      '',
      '**Status:** OK',
      '',
      'Categorized 12 transactions.',
      '',
      '### 16:40',
      '',
      'Flagged a duplicate charge.',
      '<!-- ROLE:cpa:END -->'
    ].join('\n'));

    const result = runReadPlugin(tempRoot);
    const roleEntries = result.entries.filter(e => JSON.parse(e.metadata).type === 'role');

    expect(roleEntries).toHaveLength(2);
    expect(JSON.parse(roleEntries[0].metadata)).toEqual({ type: 'role', role: 'cpa' });
    expect(roleEntries[0].date).toBe('2026-10-01T14:05:00');
    expect(roleEntries[0].text).toContain('Categorized 12 transactions.');
    expect(roleEntries[1].date).toBe('2026-10-01T16:40:00');
    // The display heading is not part of any entry
    for (const entry of roleEntries) {
      expect(entry.text).not.toContain('## 🤖');
    }
  });

  test('a ROLE block after a Journal section is not swallowed into journal entries', () => {
    writeDiary('2026-10-01', [
      '## Journal',
      '',
      '### 09:00',
      'Morning pages.',
      '',
      '<!-- ROLE:innkeeper:START -->',
      '### 10:00',
      'Side room is guest-ready.',
      '<!-- ROLE:innkeeper:END -->'
    ].join('\n'));

    const result = runReadPlugin(tempRoot);
    const byType = {};
    for (const e of result.entries) {
      const type = JSON.parse(e.metadata).type;
      (byType[type] ||= []).push(e);
    }

    expect(byType.journal).toHaveLength(1);
    expect(byType.journal[0].text).not.toContain('guest-ready');
    expect(byType.role).toHaveLength(1);
    expect(JSON.parse(byType.role[0].metadata).role).toBe('innkeeper');
  });

  test('old-file cleanup strips TODAY sections but keeps ROLE blocks', () => {
    writeDiary('2026-10-01', [
      '<!-- TODAY:STAGE_NOTICE:START -->',
      '🔧 **Back Stage** - Maintenance work',
      '<!-- TODAY:STAGE_NOTICE:END -->',
      '',
      '<!-- ROLE:cpa:START -->',
      '### 14:05',
      'Durable report.',
      '<!-- ROLE:cpa:END -->'
    ].join('\n'));

    runReadPlugin(tempRoot);

    const content = fs.readFileSync(path.join(diaryDir, '2026-10-01.md'), 'utf8');
    expect(content).not.toContain('TODAY:STAGE_NOTICE');
    expect(content).toContain('<!-- ROLE:cpa:START -->');
    expect(content).toContain('Durable report.');
  });

  test('an old file containing only a ROLE block is not deleted as empty', () => {
    writeDiary('2026-10-01', [
      '<!-- ROLE:cpa:START -->',
      '### 14:05',
      'Only a role report today.',
      '<!-- ROLE:cpa:END -->'
    ].join('\n'));

    runReadPlugin(tempRoot);

    expect(fs.existsSync(path.join(diaryDir, '2026-10-01.md'))).toBe(true);
  });

  test("today's ROLE blocks sync on the same run they are written", () => {
    const today = todayDateString();
    writeDiary(today, [
      '<!-- ROLE:chief-of-staff:START -->',
      '### 08:00',
      'Dispatch: launching cpa.',
      '<!-- ROLE:chief-of-staff:END -->'
    ].join('\n'));

    const result = runReadPlugin(tempRoot);
    const roleEntries = result.entries.filter(e => JSON.parse(e.metadata).type === 'role');
    expect(roleEntries).toHaveLength(1);
    expect(JSON.parse(roleEntries[0].metadata).role).toBe('chief-of-staff');
  });
});
