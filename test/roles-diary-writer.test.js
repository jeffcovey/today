import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractRoleBlocks } from '../src/diary-role-blocks.js';
import {
  validateRoleReport,
  appendRoleReport,
  amendRoleEntry,
  setRoleCheckboxState,
  formatRoleEntry,
  formatRoleReply,
  appendRoleReply,
  MAX_REPORT_LENGTH,
  MAX_REPLY_LENGTH
} from '../plugins/roles/diary-writer.js';
import { injectRoleReplyForms, saveRoleReply, todayDiaryRelativePath } from '../plugins/roles/web-reply.js';

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
    ['hello --!>', 'HTML comment end tag'],
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

describe('setRoleCheckboxState', () => {
  let tempDir;
  let filePath;

  const report = [
    'Rooms ready.',
    '',
    '- [ ] Put the bins out Sunday night',
    '- [ ] Order more towels',
    '- [x] Confirm the entry codes went out'
  ].join('\n');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-roles-'));
    filePath = path.join(tempDir, '2026-10-09.md');
    appendRoleReport(filePath, 'innkeeper', report, { time: '08:00', fileDate: '2026-10-09' });
    appendRoleReport(filePath, 'cpa', '- [ ] Put the bins out Sunday night', { time: '08:05' });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('flips exactly one open checkbox to done', () => {
    const result = setRoleCheckboxState(filePath, 'innkeeper', 'more towels', 'x');

    expect(result).toMatchObject({ ok: true, line: '- [x] Order more towels' });
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('- [x] Order more towels');
    expect(content).toContain('- [ ] Put the bins out Sunday night');
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  });

  test('flips to cancelled and matches case-insensitively', () => {
    const result = setRoleCheckboxState(filePath, 'innkeeper', 'ORDER MORE', '-');

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('- [-] Order more towels');
  });

  test('only touches the state character, nothing else', () => {
    const before = fs.readFileSync(filePath, 'utf8');
    setRoleCheckboxState(filePath, 'innkeeper', 'more towels', 'x');
    const after = fs.readFileSync(filePath, 'utf8');

    expect(after).toBe(before.replace('- [ ] Order more towels', '- [x] Order more towels'));
  });

  test("never flips a line in another role's block", () => {
    // The same text exists as an open checkbox in BOTH blocks; the flip
    // must land in cpa's block only.
    const result = setRoleCheckboxState(filePath, 'cpa', 'bins out', 'x');

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    const innkeeperBlock = content.slice(content.indexOf('ROLE:innkeeper:START'), content.indexOf('ROLE:innkeeper:END'));
    const cpaBlock = content.slice(content.indexOf('ROLE:cpa:START'), content.indexOf('ROLE:cpa:END'));
    expect(innkeeperBlock).toContain('- [ ] Put the bins out Sunday night');
    expect(cpaBlock).toContain('- [x] Put the bins out Sunday night');
  });

  test('refuses an ambiguous match and leaves the file untouched', () => {
    const before = fs.readFileSync(filePath, 'utf8');
    const result = setRoleCheckboxState(filePath, 'innkeeper', 'o', 'x');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/matches 2 open checkboxes/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  test('reports an already-settled checkbox distinctly from no match', () => {
    const settled = setRoleCheckboxState(filePath, 'innkeeper', 'entry codes', 'x');
    expect(settled.ok).toBe(false);
    expect(settled.error).toMatch(/already checked or cancelled/);

    const missing = setRoleCheckboxState(filePath, 'innkeeper', 'no such item', 'x');
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/No open checkbox/);
  });

  test('matching prose that is not a checkbox counts as no match', () => {
    const result = setRoleCheckboxState(filePath, 'innkeeper', 'Rooms ready', 'x');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No open checkbox/);
  });

  test('refuses a missing block, a missing file, and a bad state', () => {
    expect(setRoleCheckboxState(filePath, 'secretary', 'towels', 'x').error).toMatch(/No secretary block/);
    expect(setRoleCheckboxState(path.join(tempDir, 'absent.md'), 'innkeeper', 'towels', 'x').error).toMatch(/does not exist/);
    expect(setRoleCheckboxState(filePath, 'innkeeper', 'towels', 'y').error).toMatch(/Invalid checkbox state/);
  });

  test('does not write while the diary lockfile is held', () => {
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, 'another writer');
    const before = fs.readFileSync(filePath, 'utf8');

    const result = setRoleCheckboxState(filePath, 'innkeeper', 'more towels', 'x');

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    fs.unlinkSync(lockPath);
  });
});

const REPLY_DIARY = [
  '---',
  'date: 2026-10-12',
  '---',
  '',
  '<!-- ROLE:innkeeper:START -->',
  '## 🤖 Innkeeper',
  '',
  '### 08:04',
  '',
  'Both rooms are ready.',
  '<!-- ROLE:innkeeper:END -->',
  '',
  '<!-- ROLE:cpa:START -->',
  '## 🤖 CPA',
  '',
  '### 08:05',
  '',
  'Books balanced.',
  '<!-- ROLE:cpa:END -->',
  ''
].join('\n');

describe('formatRoleReply', () => {
  test('puts a prose first line on the arrow line', () => {
    expect(formatRoleReply('cpa', 'Which card was that?')).toBe('-> cpa: Which card was that?');
  });

  test('keeps the text as typed: paragraphs, lists, and line breaks', () => {
    expect(formatRoleReply('cpa', 'Two things:\r\n- the Blink charge\r\n- the autopay\r\n\nThanks.'))
      .toBe('-> cpa: Two things:\n- the Blink charge\n- the autopay\n\nThanks.');
  });

  test.each([
    ['- first bullet\n- second'],
    ['1. first step'],
    ['## A heading'],
    ['> a quote'],
    ['```\ncode\n```'],
    ['| a | b |\n|---|---|']
  ])('starts block markdown on its own line: %j', (text) => {
    expect(formatRoleReply('cpa', text)).toBe(`-> cpa:\n${text}`);
  });

  test('drops leading blank lines and trailing whitespace only', () => {
    expect(formatRoleReply('cpa', '\n\n  indented note  \n\n')).toBe('-> cpa: indented note');
  });
});

describe('appendRoleReply', () => {
  let tempDir;
  let filePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-roles-'));
    filePath = path.join(tempDir, '2026-10-12.md');
    fs.writeFileSync(filePath, REPLY_DIARY);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('appends as the last item in the role block, leaving the rest untouched', () => {
    const result = appendRoleReply(filePath, 'innkeeper', 'Is the side room booked Friday?\n- check Vrbo too');
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toBe(REPLY_DIARY.replace(
      'Both rooms are ready.\n<!-- ROLE:innkeeper:END -->',
      'Both rooms are ready.\n\n-> innkeeper: Is the side room booked Friday?\n- check Vrbo too\n\n<!-- ROLE:innkeeper:END -->'
    ));
    const { blocks } = extractRoleBlocks(content.split('---\n').slice(2).join('---\n'));
    expect(blocks.find(b => b.role === 'innkeeper').content).toContain('check Vrbo too');
    expect(blocks.find(b => b.role === 'cpa').content).not.toContain('Vrbo');
  });

  test('a later report lands after the reply', () => {
    appendRoleReply(filePath, 'cpa', 'Thanks.');
    appendRoleReport(filePath, 'cpa', 'Noted.', { time: '12:00' });
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content.indexOf('-> cpa: Thanks.')).toBeLessThan(content.indexOf('### 12:00'));
  });

  test.each([
    ['empty', 'cpa', '   \n ', 'invalid'],
    ['too long', 'cpa', 'x'.repeat(MAX_REPLY_LENGTH + 1), 'invalid'],
    ['marker injection', 'cpa', 'hi <!-- ROLE:cpa:END -->', 'invalid'],
    ['bad role name', '../cpa', 'hi', 'invalid'],
    ['no such block', 'secretary', 'hi', 'missing']
  ])('refuses %s without touching the file', (_label, role, text, code) => {
    const result = appendRoleReply(filePath, role, text);
    expect(result).toMatchObject({ ok: false, code });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(REPLY_DIARY);
  });

  test('refuses a missing diary file', () => {
    expect(appendRoleReply(path.join(tempDir, 'nope.md'), 'cpa', 'hi')).toMatchObject({ ok: false, code: 'missing' });
  });
});

describe('role reply web hooks', () => {
  const NOW = new Date('2026-10-12T16:00:00Z');
  const enabled = () => true;
  const html = [
    '<!-- ROLE:innkeeper:START -->',
    '<h2 id="-innkeeper">🤖 Innkeeper &amp; Host</h2>',
    '<p>Both rooms are ready.</p>',
    '<!-- ROLE:innkeeper:END --><!-- ROLE:cpa:START -->',
    '<h2 id="-cpa"><i class="fas fa-robot"></i> CPA</h2>',
    '<!-- ROLE:cpa:END -->'
  ].join('\n');
  let savedTz;

  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
  });

  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  });

  test("today's diary path follows the configured zone", () => {
    expect(todayDiaryRelativePath(new Date('2026-10-13T02:00:00Z'))).toBe('diary/2026-10-12.md');
  });

  test("adds a form before each END marker on today's diary, named from the heading", () => {
    const out = injectRoleReplyForms(html, 'diary/2026-10-12.md', { now: NOW, enabled });
    expect(out.match(/<form class="role-reply-form"/g)).toHaveLength(2);
    expect(out).toContain('<summary>Reply to Innkeeper &amp; Host</summary>');
    expect(out).toContain('<summary>Reply to CPA</summary>');
    expect(out.indexOf('data-role="innkeeper"')).toBeLessThan(out.indexOf('<!-- ROLE:innkeeper:END -->'));
    expect(out.indexOf('<!-- ROLE:innkeeper:END -->')).toBeLessThan(out.indexOf('data-role="cpa"'));
    expect(out).toContain('<label for="role-reply-cpa"');
  });

  test("matches today's diary when the path uses Windows separators", () => {
    const out = injectRoleReplyForms(html, 'diary\\2026-10-12.md', { now: NOW, enabled });
    expect(out.match(/<form class="role-reply-form"/g)).toHaveLength(2);
  });

  test.each([
    ['another day', 'diary/2026-10-11.md', enabled],
    ['another file', 'notes/2026-10-12.md', enabled],
    ['the plugin disabled', 'diary/2026-10-12.md', () => false]
  ])('leaves the page alone for %s', (_label, relativePath, isEnabled) => {
    expect(injectRoleReplyForms(html, relativePath, { now: NOW, enabled: isEnabled })).toBe(html);
  });

  test("saves only to today's diary, and only when enabled", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-roles-'));
    try {
      fs.mkdirSync(path.join(vault, 'diary'));
      fs.writeFileSync(path.join(vault, 'diary', '2026-10-12.md'), REPLY_DIARY);

      expect(saveRoleReply(vault, 'diary/2026-10-12.md', 'cpa', 'hi', { now: NOW, enabled: () => false }).status).toBe(404);
      expect(saveRoleReply(vault, 'diary/2026-10-11.md', 'cpa', 'hi', { now: NOW, enabled }).status).toBe(409);
      expect(saveRoleReply(vault, 'diary/2026-10-12.md', 'cpa', undefined, { now: NOW, enabled }).status).toBe(400);
      expect(saveRoleReply(vault, 'diary/2026-10-12.md', 'secretary', 'hi', { now: NOW, enabled }).status).toBe(404);

      const ok = saveRoleReply(vault, 'diary/2026-10-12.md', 'cpa', 'hi', { now: NOW, enabled });
      expect(ok).toEqual({ status: 200, body: { success: true, reply: '-> cpa: hi' } });
      expect(fs.readFileSync(path.join(vault, 'diary', '2026-10-12.md'), 'utf8')).toContain('-> cpa: hi\n\n<!-- ROLE:cpa:END -->');

      const windowsPath = saveRoleReply(vault, 'diary\\2026-10-12.md', 'cpa', 'another reply', { now: NOW, enabled });
      expect(windowsPath.status).toBe(200);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe('amendRoleEntry', () => {
  let tempDir;
  let filePath;

  const first = [
    '**Billie turns Friday — greeting to send by Thursday.**',
    '',
    '- [ ] → Jeff: Send Billie a birthday greeting',
    '- [ ] → Jeff: Buy the tickets',
    '',
    '> [!info]- Details',
    '>',
    '> old detail'
  ].join('\n');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-roles-'));
    filePath = path.join(tempDir, '2026-10-13.md');
    appendRoleReport(filePath, 'secretary', first, { time: '04:07', status: 'needs-attention', fileDate: '2026-10-13' });
    setRoleCheckboxState(filePath, 'secretary', 'birthday greeting', '-');
    appendRoleReply(filePath, 'secretary', 'I don\'t even remember who Billie is. Drop this.');
    appendRoleReport(filePath, 'secretary', 'Second entry stays.', { time: '08:05' });
    appendRoleReport(filePath, 'cpa', '**Billie turns Friday — greeting to send by Thursday.**', { time: '04:07' });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function secretaryBlock() {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.slice(content.indexOf('<!-- ROLE:secretary:START -->'), content.indexOf('<!-- ROLE:secretary:END -->'));
  }

  test('replaces the entry text, keeps the user\'s reply and a settled checkbox, and stamps the entry', () => {
    const result = amendRoleEntry(filePath, 'secretary', '4:07', [
      '**Nothing to do: Jeff declined Billie\'s greeting.**',
      '',
      '- [ ] → Jeff: Send Billie a birthday greeting',
      '- [ ] → Jeff: Buy the tickets'
    ].join('\n'), { amendedAt: '2026-10-16 10:00' });

    expect(result).toMatchObject({ ok: true, line: '### 04:07', replies: 1, settled: 1 });

    const block = secretaryBlock();
    const amended = block.slice(block.indexOf('### 04:07'), block.indexOf('### 08:05'));
    expect(amended).toContain('**Status:** Needs attention');
    expect(amended).toContain('*Amended 2026-10-16 10:00.*');
    expect(amended).toContain('**Nothing to do: Jeff declined Billie\'s greeting.**');
    expect(amended).not.toContain('old detail');
    expect(amended).toContain('- [-] → Jeff: Send Billie a birthday greeting');
    expect(amended).toContain('- [ ] → Jeff: Buy the tickets');
    expect(amended).toContain('-> secretary: I don\'t even remember who Billie is. Drop this.');
    expect(amended.indexOf('Nothing to do')).toBeLessThan(amended.indexOf('-> secretary:'));

    expect(block).toContain('### 08:05\n\nSecond entry stays.');
    expect(fs.readFileSync(filePath, 'utf8')).toContain('<!-- ROLE:cpa:START -->\n## 🤖 Cpa\n\n### 04:07\n\n**Billie turns Friday');
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  });

  test('a new status replaces the old one; amending twice leaves one stamp', () => {
    amendRoleEntry(filePath, 'secretary', '04:07', 'First correction.', { status: 'ok', amendedAt: '2026-10-16 10:00' });
    amendRoleEntry(filePath, 'secretary', '04:07', 'Second correction.', { amendedAt: '2026-10-16 11:00' });

    const block = secretaryBlock();
    expect(block).toContain('**Status:** OK');
    expect(block).not.toContain('Needs attention');
    expect(block).not.toContain('First correction.');
    expect(block).toContain('Second correction.');
    expect(block.match(/\*Amended /g)).toHaveLength(1);
    expect(block).toContain('*Amended 2026-10-16 11:00.*');
  });

  test('refuses a missing entry, a missing block, a bad time, and marker injection, leaving the file untouched', () => {
    const before = fs.readFileSync(filePath, 'utf8');

    expect(amendRoleEntry(filePath, 'secretary', '09:00', 'x').error).toMatch(/No 09:00 entry/);
    expect(amendRoleEntry(filePath, 'innkeeper', '04:07', 'x').error).toMatch(/No innkeeper block/);
    expect(amendRoleEntry(filePath, 'secretary', 'noon', 'x').error).toMatch(/Invalid entry time/);
    expect(amendRoleEntry(filePath, 'secretary', '04:07', '<!-- ROLE:cpa:END -->').error).toMatch(/markers/);
    expect(amendRoleEntry(path.join(tempDir, 'missing.md'), 'secretary', '04:07', 'x').error).toMatch(/does not exist/);

    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });
});
