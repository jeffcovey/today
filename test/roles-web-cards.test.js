import { marked } from 'marked';
import { parseRoleBlock, splitLatest, roleBlocksToCards } from '../plugins/roles/web-cards.js';

const DIARY = [
  '## Journal',
  '',
  'Morning note.',
  '',
  '<!-- ROLE:chief-of-staff:START -->',
  '## 🤖 Chief of Staff',
  '',
  '### 04:03',
  '',
  '> [!abstract]- Dispatch: innkeeper (1 skipped)',
  '>',
  '> - innkeeper: checkout today',
  '',
  '### 04:07',
  '',
  '**Checkout at noon.**',
  '',
  '### 08:03',
  '',
  '> [!abstract]- Dispatch: innkeeper (5 others current)',
  '>',
  '> - innkeeper: Jeff replied',
  '',
  '### 08:07',
  '',
  '**STR pays more.**',
  '<!-- ROLE:chief-of-staff:END -->',
  '',
  '<!-- ROLE:innkeeper:START -->',
  '## 🤖 Innkeeper',
  '',
  '### 04:06',
  '',
  '**Status:** Needs attention',
  '',
  '**Joe checks out at noon.**',
  '',
  '- [ ] → Jeff: Reply to Dallas',
  '- [ ] Old task {data-file="diary/x.md" data-line="40" data-cancelled="true"}',
  '- [x] Done task',
  '',
  '-> innkeeper: How does the income compare?',
  '- he wants the busy season',
  '',
  '### 08:07',
  '',
  '**STR runs $18K–$20K.**',
  '',
  '-> innkeeper: I turned him down.',
  '',
  '-> cpa: Note the lost income.',
  '<!-- ROLE:innkeeper:END -->',
  '',
  '<!-- ROLE:cpa:START -->',
  '## 🤖 CPA',
  '',
  '### 04:05',
  '',
  '**Books balanced.**',
  '',
  '```',
  '-> innkeeper: not a reply, inside a fence',
  '### not an entry',
  '```',
  '<!-- ROLE:cpa:END -->',
  ''
].join('\n');

const ROLES = new Set(['chief-of-staff', 'innkeeper', 'cpa']);

function blockContent(role) {
  const start = DIARY.indexOf(`<!-- ROLE:${role}:START -->`) + `<!-- ROLE:${role}:START -->`.length;
  return DIARY.slice(start, DIARY.indexOf(`<!-- ROLE:${role}:END -->`));
}

describe('parseRoleBlock', () => {
  test('reads the title, entries, dispatch notes, status, and replies', () => {
    const chief = parseRoleBlock(blockContent('chief-of-staff'), ROLES);
    expect(chief.title).toBe('Chief of Staff');
    expect(chief.segments.map(s => [s.heading, s.dispatch])).toEqual([
      ['04:03', true], ['04:07', false], ['08:03', true], ['08:07', false]
    ]);

    const inn = parseRoleBlock(blockContent('innkeeper'), ROLES);
    expect(inn.segments.map(s => s.kind)).toEqual(['entry', 'reply', 'entry', 'reply', 'reply']);
    expect(inn.segments[0].status).toBe('Needs attention');
    expect(inn.segments[0].lines[0]).toBe('**Joe checks out at noon.**');
    expect(inn.segments[1]).toMatchObject({ to: 'innkeeper', lines: ['How does the income compare?', '- he wants the busy season'] });
    expect(inn.segments[4].to).toBe('cpa');
  });

  test('ignores arrows and headings inside code fences, and arrows to unknown names', () => {
    const cpa = parseRoleBlock(blockContent('cpa'), ROLES);
    expect(cpa.segments).toHaveLength(1);
    const jeff = parseRoleBlock('### 09:00\n\n-> jeff: not one of the roles', ROLES);
    expect(jeff.segments).toHaveLength(1);
  });
});

describe('splitLatest', () => {
  test('keeps the latest report and what led to it open', () => {
    const chief = parseRoleBlock(blockContent('chief-of-staff'), ROLES);
    const { earlier, latest } = splitLatest(chief.segments);
    expect(earlier.map(s => s.heading)).toEqual(['04:03', '04:07']);
    expect(latest.map(s => s.heading)).toEqual(['08:03', '08:07']);

    const inn = parseRoleBlock(blockContent('innkeeper'), ROLES);
    const split = splitLatest(inn.segments);
    expect(split.earlier.map(s => s.kind)).toEqual(['entry']);
    expect(split.latest.map(s => s.kind)).toEqual(['reply', 'entry', 'reply', 'reply']);
  });

  test('a single report has nothing earlier', () => {
    const cpa = parseRoleBlock(blockContent('cpa'), ROLES);
    expect(splitLatest(cpa.segments).earlier).toEqual([]);
  });
});

describe('roleBlocksToCards', () => {
  const html = marked.parse(roleBlocksToCards(DIARY));

  test('leaves Markdown without role blocks alone', () => {
    expect(roleBlocksToCards('## Journal\n\nHi.\n')).toBe('## Journal\n\nHi.\n');
  });

  test('keeps the rest of the diary and the block markers', () => {
    expect(html).toContain('Morning note.');
    for (const role of ROLES) {
      expect(html).toContain(`<!-- ROLE:${role}:START -->`);
      expect(html).toContain(`<!-- ROLE:${role}:END -->`);
    }
  });

  test('introduces the cards with a staff line', () => {
    expect(html).toMatch(/<div class="role-staff-head"[^>]*><span class="role-staff-title">Staff<\/span> <span class="role-staff-meta">3 roles · latest report 08:07<\/span>/);
  });

  test('renders a card header with name, status pill, and last report time', () => {
    const inn = html.slice(html.indexOf('id="role-innkeeper"'), html.indexOf('<!-- ROLE:innkeeper:END -->'));
    expect(html).toContain('<div class="role-card role-card-attn" id="role-innkeeper">');
    expect(inn).toMatch(/<h2[^>]*>🤖 Innkeeper<\/h2>/);
    expect(inn).toContain('<span class="role-pill role-pill-attn">Needs attention</span>');
    expect(inn).toContain('Updated 08:07');
    expect(inn).not.toContain('**Status:**');
    expect(html).toContain('<div class="role-card" id="role-cpa">');
  });

  test('does not count a dispatch timestamp as a report time', () => {
    const diary = [
      '<!-- ROLE:innkeeper:START -->',
      '## 🤖 Innkeeper',
      '',
      '### 09:00',
      '',
      'Report.',
      '',
      '### 10:00',
      '',
      '> [!abstract]- Dispatch: cpa',
      '>',
      '> - cpa: message',
      '<!-- ROLE:innkeeper:END -->'
    ].join('\n');
    const cards = roleBlocksToCards(diary);

    expect(cards).toContain('<span class="role-staff-meta">1 role · latest report 09:00</span>');
    expect(cards).toContain('Updated 09:00');
    expect(cards).not.toContain('Updated 10:00');
  });

  test('renders replies as bubbles, Markdown intact, naming another role when addressed', () => {
    expect(html).toMatch(/<div class="role-you">\s*<span class="role-you-label">You<\/span>\s*<p>How does the income compare\?<\/p>\s*<ul>\s*<li>he wants the busy season<\/li>/);
    expect(html).toContain('<span class="role-you-label">You → CPA</span>');
    expect(html).not.toContain('-&gt; innkeeper: How');
  });

  test('folds earlier entries, counting only still-open checkboxes', () => {
    expect(html).toContain('<summary>Earlier · 04:03, 04:07</summary>');
    expect(html).toContain('<summary>Earlier · 04:06 · 1 open item</summary>');
    const earlier = html.slice(html.indexOf('Earlier · 04:06'));
    expect(earlier.indexOf('Joe checks out')).toBeGreaterThan(-1);
    expect(html.indexOf('STR runs')).toBeLessThan(html.indexOf('Earlier · 04:06'));
  });

  test('puts a dispatch note on one line with its time in the title', () => {
    expect(html).toContain('[!abstract]- 08:03 · Dispatch: innkeeper (5 others current)');
    expect(html).not.toMatch(/<h3[^>]*>08:03<\/h3>/);
  });

  test('keeps the END marker in the card footer for the reply form', () => {
    expect(html).toMatch(/<div class="role-card-foot">\s*<!-- ROLE:cpa:END -->\s*<\/div>\s*<\/div>/);
  });
});
