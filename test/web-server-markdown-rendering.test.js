import fs from 'fs';
import * as yaml from 'js-yaml';

const webServerSource = fs.readFileSync(new URL('../src/web-server.js', import.meta.url), 'utf8');

function extractFunctionSource(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map(marker => webServerSource.indexOf(marker))
    .find(index => index !== -1);

  if (start === undefined) {
    throw new Error(`Could not find function ${name}`);
  }

  const parenStart = webServerSource.indexOf('(', start);
  let parenDepth = 0;
  let braceStart = -1;

  for (let index = parenStart; index < webServerSource.length; index++) {
    const char = webServerSource[index];
    if (char === '(') parenDepth++;
    if (char === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        braceStart = webServerSource.indexOf('{', index);
        break;
      }
    }
  }

  if (braceStart === -1) {
    throw new Error(`Could not find function body for ${name}`);
  }

  let depth = 0;

  for (let index = braceStart; index < webServerSource.length; index++) {
    const char = webServerSource[index];
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return webServerSource.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Could not extract function ${name}`);
}

const resolveDataviewPath = new Function(`${extractFunctionSource('resolveDataviewPath')}; return resolveDataviewPath;`)();
const formatInlineDataviewValue = new Function(
  'formatDate',
  `${extractFunctionSource('formatInlineDataviewValue')}; return formatInlineDataviewValue;`
)(date => date.toISOString().slice(0, 10));
const processInlineDataview = new Function(
  'resolveDataviewPath',
  'formatInlineDataviewValue',
  'DataviewAPI',
  'debug',
  `${extractFunctionSource('processInlineDataview')}; return processInlineDataview;`
)(resolveDataviewPath, formatInlineDataviewValue, class DataviewAPI {}, () => {});
const parseTableOfContentsOptions = new Function(
  'yaml',
  'debug',
  `${extractFunctionSource('parseTableOfContentsOptions')}; return parseTableOfContentsOptions;`
)(yaml, () => {});
const replaceTableOfContentsBlocks = new Function(
  'parseTableOfContentsOptions',
  `${extractFunctionSource('replaceTableOfContentsBlocks')}; return replaceTableOfContentsBlocks;`
)(parseTableOfContentsOptions);
const generateTableOfContents = new Function(
  'getHeadingList',
  `${extractFunctionSource('generateTableOfContents')}; return generateTableOfContents;`
)(() => [
  { level: 2, id: 'overview', text: 'Overview' },
  { level: 3, id: 'details', text: 'Details' },
  { level: 4, id: 'appendix', text: 'Appendix' }
]);
const renderTableOfContentsBlocks = new Function(
  'generateTableOfContents',
  `${extractFunctionSource('renderTableOfContentsBlocks')}; return renderTableOfContentsBlocks;`
)(generateTableOfContents);

describe('web-server markdown rendering helpers', () => {
  test('processInlineDataview resolves nested this paths in both syntaxes', async () => {
    const content = 'Current: =this.metrics.current_weight lbs and `$= this.metrics.target_weight` lbs';
    const properties = {
      metrics: {
        current_weight: 185,
        target_weight: 170
      }
    };

    const rendered = await processInlineDataview(content, properties, '/vault', '/vault/page.md');

    expect(rendered).toBe('Current: 185 lbs and 170 lbs');
  });

  test('processInlineDataview fails quietly for missing keys and object values', async () => {
    const content = 'Parent: =this.metrics Missing: =this.metrics.unknown Value: `$= this.metrics.unknown`';
    const properties = {
      metrics: {
        current_weight: 185
      }
    };

    const rendered = await processInlineDataview(content, properties, '/vault', '/vault/page.md');

    expect(rendered).toBe('Parent:  Missing:  Value: ');
    expect(rendered).not.toContain('[object Object]');
  });

  test('table-of-contents blocks render heading links instead of leaking config', () => {
    const markdown = `Intro

\`\`\`table-of-contents
minLevel: 3
maxLevel: 3
\`\`\`

After`;

    const { content, tocBlocks } = replaceTableOfContentsBlocks(markdown);
    const html = renderTableOfContentsBlocks(content, tocBlocks);

    expect(content).toContain('<!--TOC_PLACEHOLDER_0-->');
    expect(content).not.toContain('minLevel: 3');
    expect(html).toContain('href="#details"');
    expect(html).not.toContain('href="#overview"');
    expect(html).not.toContain('minLevel: 3');
    expect(html).not.toContain('maxLevel: 3');
  });
});
