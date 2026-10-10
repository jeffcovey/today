/**
 * Accessibility regression tests for the web view, in the light and dark
 * themes at phone and desktop sizes. Renders the fixture vault in
 * test/fixtures/a11y-vault through the real server and headless Chrome.
 *
 * - axe-core's WCAG 2.2 AA rules (contrast, names, labels, target sizes...)
 *   with every collapsible closed and then opened, so hidden content counts;
 * - pinned (sticky or fixed) elements never overlap each other after
 *   scrolling, so a sticky header can't cover another one.
 */

import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import {
  startServer,
  auditPage,
  findPinnedOverlaps,
  openDiff,
  PASSWORD,
  PAGES,
  THEMES,
  VIEWPORTS
} from './helpers/a11y-harness.js';

jest.setTimeout(240_000);

let server;
let browser;

beforeAll(async () => {
  server = await startServer();
  browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] });
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

const combinations = (pages) => pages.flatMap(page =>
  THEMES.flatMap(theme => Object.keys(VIEWPORTS).map(viewport => [page.name, theme, viewport, page])));

function describeViolation(v) {
  const detail = (v.summary || '').split('\n').map(s => s.trim()).filter(Boolean).slice(1, 2).join(' ');
  return `${v.rule} (${v.state}) ${v.target}: ${detail}`;
}

describe('web view accessibility (axe-core, WCAG 2.2 AA)', () => {
  test.each(combinations(PAGES))('%s, %s theme, %s size: no violations', async (_name, theme, viewport, page) => {
    const violations = await auditPage(browser, { baseUrl: server.baseUrl, page, theme, viewport });
    expect(violations.map(describeViolation)).toEqual([]);
  });
});

describe('web view layout', () => {
  const longPages = PAGES.filter(p => ['kitchen-sink', 'diary'].includes(p.name));

  test.each(combinations(longPages))('%s, %s theme, %s size: pinned elements never overlap', async (_name, theme, viewport, page) => {
    const overlaps = await findPinnedOverlaps(browser, { baseUrl: server.baseUrl, page, theme, viewport });
    expect(overlaps).toEqual([]);
  });
});

describe('git page diffs', () => {
  test('dark theme directory headers differ from file rows in the same list', async () => {
    const page = await browser.newPage();
    try {
      await page.evaluateOnNewDocument(() => localStorage.setItem('todayThemeMode', 'dark'));
      await page.setExtraHTTPHeaders({ Authorization: 'Bearer ' + PASSWORD });
      await page.goto(`${server.baseUrl}/_git`, { waitUntil: 'networkidle0' });
      expect(await page.$eval('html', el => el.dataset.theme)).toBe('dark');

      const backgrounds = await page.$eval('.git-dir-header', header => {
        const file = header.closest('.list-group').querySelector('.file-item');
        return {
          header: getComputedStyle(header).backgroundColor,
          file: getComputedStyle(file).backgroundColor
        };
      });
      expect(backgrounds.header).not.toBe(backgrounds.file);
    } finally {
      await page.close();
    }
  });

  test.each([['light', 'dark'], ['dark', 'light']])('follow the theme: %s, then switched to %s', async (first, second) => {
    const page = await browser.newPage();
    try {
      await page.evaluateOnNewDocument((mode) => localStorage.setItem('todayThemeMode', mode), first);
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await page.goto(`${server.baseUrl}/_git`, { waitUntil: 'networkidle0' });
      const headerBackground = () => page.$eval('.git-dir-header', el => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'var(--today-surface-2)';
        el.appendChild(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { actual: getComputedStyle(el).backgroundColor, expected };
      });
      let background = await headerBackground();
      expect(background.actual).toBe(background.expected);
      await openDiff(page, 'code/example.js');

      const scheme = () => page.$eval('#diffContent .d2h-wrapper', el =>
        [...el.classList].find(c => /^d2h-(light|dark|auto)-color-scheme$/.test(c)) || 'none');
      expect(await scheme()).toBe(`d2h-${first}-color-scheme`);

      await page.evaluate((mode) => setThemeMode(mode), second);
      await page.waitForSelector(`#diffContent .d2h-wrapper.d2h-${second}-color-scheme .hljs`, { timeout: 10_000 });
      expect(await scheme()).toBe(`d2h-${second}-color-scheme`);
      background = await headerBackground();
      expect(background.actual).toBe(background.expected);
    } finally {
      await page.close();
    }
  });
});

describe('task markers', () => {
  const MARKER = /[🔺⏫🔼🔽⏬⏳🛫➕🔁📅✅❌]/u;

  test.each([
    ['Markdown task list', '/notes/kitchen-sink.md', 'li'],
    ['task query results', '/projects/sample-project.md', '.tasks-query-result li']
  ])('%s show icons, not raw emoji', async (_label, pagePath, itemSelector) => {
    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await page.goto(`${server.baseUrl}${pagePath}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(`${itemSelector} input.task-checkbox`, { timeout: 15_000 });

      const items = await page.$$eval(`${itemSelector}`, (els) => els
        .filter(li => li.querySelector('input.task-checkbox'))
        .map(li => ({ text: li.textContent.replace(/\s+/g, ' ').trim(), icons: li.querySelectorAll('i.fas').length })));
      const brokenAttributes = await page.$$eval('[href], [title]', els => els
        .flatMap(el => [el.getAttribute('href'), el.getAttribute('title')])
        .filter(value => value?.includes('<i')));

      expect(items.length).toBeGreaterThan(0);
      expect(items.filter(item => MARKER.test(item.text)).map(item => item.text)).toEqual([]);
      expect(items.some(item => item.icons > 0)).toBe(true);
      expect(brokenAttributes).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
