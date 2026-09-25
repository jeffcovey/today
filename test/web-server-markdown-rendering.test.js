import {
  formatInlineDataviewValue,
  generateTableOfContentsHtml,
  renderTableOfContentsCodeBlocks,
  resolveDataviewPath,
} from '../src/markdown-rendering.js';

describe('web-server markdown rendering helpers', () => {
  test('nested this paths resolve for inline dataview rendering', () => {
    const properties = {
      metrics: {
        current_weight: 185,
        target_weight: 170
      }
    };

    const currentWeight = formatInlineDataviewValue(resolveDataviewPath(properties, 'metrics.current_weight'), '');
    const targetWeight = formatInlineDataviewValue(resolveDataviewPath(properties, 'metrics.target_weight'), '');

    expect(`Current: ${currentWeight} lbs and ${targetWeight} lbs`).toBe('Current: 185 lbs and 170 lbs');
  });

  test('missing keys and object values fail quietly for this-path rendering', () => {
    const properties = {
      metrics: {
        current_weight: 185
      }
    };

    const parentValue = formatInlineDataviewValue(resolveDataviewPath(properties, 'metrics'), '');
    const missingValue = formatInlineDataviewValue(resolveDataviewPath(properties, 'metrics.unknown'), '');

    expect(`Parent: ${parentValue} Missing: ${missingValue}`).toBe('Parent:  Missing: ');
    expect(`Parent: ${parentValue} Missing: ${missingValue}`).not.toContain('[object Object]');
  });

  test('table-of-contents code blocks render heading links instead of leaking config', () => {
    const html = renderTableOfContentsCodeBlocks(
      `<p>Intro</p>
<pre><code class="language-table-of-contents">minLevel: 3
maxLevel: 3</code></pre>
<p>After</p>`,
      [
        { level: 2, id: 'overview', text: 'Overview' },
        { level: 3, id: 'details', text: 'Details' },
        { level: 4, id: 'appendix', text: 'Appendix' }
      ]
    );

    expect(html).toContain('href="#details"');
    expect(html).not.toContain('href="#overview"');
    expect(html).not.toContain('minLevel: 3');
    expect(html).not.toContain('maxLevel: 3');
  });

  test('table-of-contents code blocks decode HTML-encoded config before parsing', () => {
    const html = renderTableOfContentsCodeBlocks(
      '<pre><code class="language-table-of-contents">minLevel: 3&#10;maxLevel: 3</code></pre>',
      [
        { level: 2, id: 'overview', text: 'Overview' },
        { level: 3, id: 'details', text: 'Details' },
        { level: 4, id: 'appendix', text: 'Appendix' }
      ]
    );

    expect(html).toContain('href="#details"');
    expect(html).not.toContain('href="#overview"');
    expect(html).not.toContain('href="#appendix"');
  });

  test('table of contents preserves heading inline HTML in link text', () => {
    const html = generateTableOfContentsHtml([
      {
        level: 2,
        id: 'usage-of-diff',
        text: 'Usage of <code>diff()</code>'
      }
    ]);

    expect(html).toContain('href="#usage-of-diff"');
    expect(html).toContain('>Usage of <code>diff()</code></a>');
    expect(html).not.toContain('&lt;code&gt;diff()&lt;/code&gt;');
  });
});
