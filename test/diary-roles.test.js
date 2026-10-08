import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  extractRoleBlocks,
  validateRoleReport,
  appendRoleReport,
  formatRoleEntry,
  MAX_REPORT_LENGTH
} from '../src/diary-roles.js';

describe('extractRoleBlocks', () => {
  test('extracts a block and removes it from the remainder', () => {
    const body = [
      '## Journal',
      '',
      '### 09:00',
      'Morning note',
      '',
      '<!-- ROLE:cpa:START -->',
      '## 🤖 CPA',
      '',
      '### 14:05',
      'Categorized 12 transactions.',
      '<!-- ROLE:cpa:END -->',
      ''
    ].join('\n');

    const { blocks, remainder } = extractRoleBlocks(body);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].role).toBe('cpa');
    expect(blocks[0].content).toContain('Categorized 12 transactions.');
    expect(blocks[0].content).not.toContain('## 🤖 CPA');
    expect(remainder).not.toContain('ROLE:cpa');
    expect(remainder).not.toContain('Categorized');
    expect(remainder).toContain('Morning note');
  });

  test('extracts multiple blocks for different roles', () => {
    const body = [
      '<!-- ROLE:cpa:START -->',
      '### 08:00',
      'Books balanced.',
      '<!-- ROLE:cpa:END -->',
      '',
      '<!-- ROLE:innkeeper:START -->',
      '### 09:30',
      'Side room ready for 3 PM check-in.',
      '<!-- ROLE:innkeeper:END -->'
    ].join('\n');

    const { blocks, remainder } = extractRoleBlocks(body);

    expect(blocks.map(b => b.role)).toEqual(['cpa', 'innkeeper']);
    expect(remainder.trim()).toBe('');
  });

  test('a START marker without its matching END extracts nothing', () => {
    const body = '<!-- ROLE:cpa:START -->\ndangling content\n';
    const { blocks, remainder } = extractRoleBlocks(body);
    expect(blocks).toHaveLength(0);
    expect(remainder).toBe(body);
  });
});

describe('validateRoleReport', () => {
  test('accepts a valid report', () => {
    expect(validateRoleReport('cpa', 'All good.', { status: 'ok' })).toEqual([]);
  });

  test.each([
    ['CPA', 'uppercase'],
    ['-cpa', 'leading hyphen'],
    ['a'.repeat(33), 'too long'],
    ['', 'empty']
  ])('rejects role name %s (%s)', (name) => {
    expect(validateRoleReport(name, 'text').length).toBeGreaterThan(0);
  });

  test('rejects empty and oversized reports', () => {
    expect(validateRoleReport('cpa', '   ')).toHaveLength(1);
    expect(validateRoleReport('cpa', 'x'.repeat(MAX_REPORT_LENGTH + 1))).toHaveLength(1);
  });

  test('rejects marker injection', () => {
    expect(validateRoleReport('cpa', 'before <!-- ROLE:cpa:END --> after')).toHaveLength(1);
    expect(validateRoleReport('cpa', '<!-- TODAY:STAGE_NOTICE:START -->')).toHaveLength(1);
  });

  test('rejects unknown status', () => {
    expect(validateRoleReport('cpa', 'text', { status: 'fine' })).toHaveLength(1);
  });

  test.each([
    ['  ', 'empty'],
    ['multi\nline', 'multiple lines'],
    ['multi\u2028line', 'Unicode line separator'],
    ['x'.repeat(81), 'too long'],
    ['hello <!-- comment -->', 'comment delimiters'],
    ['hello ROLE:cpa:END', 'role marker'],
    ['hello TODAY:START', 'today marker']
  ])('rejects invalid title (%s: %s)', (title) => {
    expect(validateRoleReport('cpa', 'text', { title }).length).toBeGreaterThan(0);
  });

  test('accepts a valid title', () => {
    expect(validateRoleReport('cpa', 'text', { title: 'Bookkeeper' })).toEqual([]);
  });
});

describe('formatRoleEntry', () => {
  test('includes timestamp heading and status line', () => {
    const entry = formatRoleEntry('Did things.', { time: '14:05', status: 'needs-attention' });
    expect(entry).toContain('### 14:05');
    expect(entry).toContain('**Status:** Needs attention');
    expect(entry).toContain('Did things.');
  });
});

describe('appendRoleReport', () => {
  let tempDir;
  let filePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-roles-'));
    filePath = path.join(tempDir, '2026-10-08.md');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates the file and block when missing', () => {
    const result = appendRoleReport(filePath, 'cpa', 'First report.', {
      time: '10:00',
      status: 'ok',
      fileDate: '2026-10-08'
    });

    expect(result).toMatchObject({ ok: true, createdFile: true, createdBlock: true });

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('date: 2026-10-08');
    expect(content).toContain('<!-- ROLE:cpa:START -->');
    expect(content).toContain('## 🤖 Cpa');
    expect(content).toContain('### 10:00');
    expect(content).toContain('First report.');
    expect(content).toContain('<!-- ROLE:cpa:END -->');
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  });

  test('does not write when the diary lockfile is already held', () => {
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, 'another writer');

    const result = appendRoleReport(filePath, 'cpa', 'First report.', { fileDate: '2026-10-08' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain(lockPath);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test('removes and replaces a stale diary lockfile', () => {
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, 'stale writer');
    const staleTime = new Date(Date.now() - 11_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    const result = appendRoleReport(filePath, 'cpa', 'Recovered report.', { fileDate: '2026-10-08' });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('Recovered report.');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('appends inside the block, preserving earlier entries and user replies', () => {
    appendRoleReport(filePath, 'cpa', 'First report.', { time: '10:00', fileDate: '2026-10-08' });

    // User replies inside the block between runs
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace('First report.', 'First report.\n\n→ cpa: yes, proceed');
    fs.writeFileSync(filePath, content);

    const result = appendRoleReport(filePath, 'cpa', 'Second report.', { time: '16:00' });
    expect(result).toMatchObject({ ok: true, createdFile: false, createdBlock: false });

    const final = fs.readFileSync(filePath, 'utf8');
    expect(final).toContain('First report.');
    expect(final).toContain('→ cpa: yes, proceed');
    expect(final).toContain('Second report.');
    // Second entry lands after the reply, before the END marker
    expect(final.indexOf('→ cpa: yes, proceed')).toBeLessThan(final.indexOf('Second report.'));
    expect(final.indexOf('Second report.')).toBeLessThan(final.indexOf('<!-- ROLE:cpa:END -->'));
    // Only one block exists
    expect(final.match(/<!-- ROLE:cpa:START -->/g)).toHaveLength(1);
  });

  test('keeps separate blocks for separate roles', () => {
    appendRoleReport(filePath, 'cpa', 'Books.', { time: '10:00', fileDate: '2026-10-08' });
    appendRoleReport(filePath, 'innkeeper', 'Rooms.', { time: '11:00' });

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('<!-- ROLE:cpa:START -->');
    expect(content).toContain('<!-- ROLE:innkeeper:START -->');
    expect(content.indexOf('<!-- ROLE:cpa:END -->')).toBeLessThan(content.indexOf('<!-- ROLE:innkeeper:START -->'));
  });

  test('uses a custom title when creating the block', () => {
    appendRoleReport(filePath, 'cpa', 'Books.', { time: '10:00', fileDate: '2026-10-08', title: 'Bookkeeper' });
    expect(fs.readFileSync(filePath, 'utf8')).toContain('## 🤖 Bookkeeper');
  });

  test('rejects a custom title that could corrupt the role block', () => {
    const result = appendRoleReport(filePath, 'cpa', 'Books.', {
      title: 'CPA\n<!-- ROLE:cpa:END -->'
    });

    expect(result.ok).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('refuses invalid reports without touching the file', () => {
    const result = appendRoleReport(filePath, 'cpa', '<!-- ROLE:cpa:END -->', { fileDate: '2026-10-08' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/markers/);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
