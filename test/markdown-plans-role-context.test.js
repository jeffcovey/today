import { extractRoleSections, removeRoleBlocks } from '../plugins/markdown-plans/role-context.js';

describe('daily plan role context', () => {
  test('keeps internal Markdown headings and replies attached to the marked role block', () => {
    const body = [
      '## 🤖 CPA',
      'ordinary section content',
      '<!-- ROLE:cpa:START -->',
      '## 🤖 CPA',
      '',
      '### 08:00',
      '',
      '-> cpa:',
      '## Decision',
      'Drop this.',
      '<!-- ROLE:cpa:END -->',
      ''
    ].join('\n');

    const [section] = extractRoleSections(body);
    expect(section.title).toBe('CPA');
    expect(section.content).toContain('## Decision\nDrop this.');
    expect(removeRoleBlocks(body)).toContain('## 🤖 CPA\nordinary section content');
    expect(removeRoleBlocks(body)).not.toContain('Drop this.');
  });

  test('accepts CRLF role markers', () => {
    const body = '<!-- ROLE:secretary:START -->\r\n## 🤖 Secretary\r\n\r\n### 08:00\r\nReport.\r\n<!-- ROLE:secretary:END -->';
    expect(extractRoleSections(body)).toEqual([{ title: 'Secretary', content: '### 08:00\r\nReport.' }]);
  });
});
