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
  useTheme,
  PASSWORD,
  PAGES,
  THEMES,
  TODAY_PLAN_PATH,
  VIEWPORTS
} from './helpers/a11y-harness.js';
import fs from 'fs';
import path from 'path';

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
      await useTheme(page, 'dark');
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
      await useTheme(page, first);
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

describe('code blocks', () => {
  test.each([
    ['kitchen-sink', '.markdown-content pre'],
    ['toml', '.toml-content']
  ].flatMap(([name, selector]) => THEMES.map(theme => [name, theme, selector])))('%s, %s theme: background follows the theme', async (name, theme, selector) => {
    const page = await browser.newPage();
    try {
      await useTheme(page, theme);
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await page.goto(server.baseUrl + PAGES.find(p => p.name === name).path, { waitUntil: 'networkidle0' });
      const background = await page.$eval(selector, el => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'var(--today-code-block-bg)';
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { actual: getComputedStyle(el).backgroundColor, expected };
      });
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

describe('role reply forms', () => {
  test("appear under each role block in today's plan only", async () => {
    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await page.goto(`${server.baseUrl}${TODAY_PLAN_PATH}`, { waitUntil: 'networkidle0' });
      expect(await page.$$eval('form.role-reply-form', forms => forms.map(f => f.dataset.role)))
        .toEqual(['chief-of-staff', 'innkeeper']);
      expect(await page.$eval('details.role-reply', el => el.open)).toBe(false);

      await page.goto(`${server.baseUrl}/diary/2026-01-15.md`, { waitUntil: 'networkidle0' });
      expect(await page.$$('form.role-reply-form')).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  test('save a multi-line reply as the last item in the block, formatting intact', async () => {
    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await page.goto(`${server.baseUrl}${TODAY_PLAN_PATH}`, { waitUntil: 'networkidle0' });
      await page.click('details.role-reply:has(form[data-role="innkeeper"]) > summary');
      await page.type('form[data-role="innkeeper"] textarea', 'Thanks. Two things:\n- check the side room\n- confirm the cleaner');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('form[data-role="innkeeper"] button[type="submit"]')
      ]);

      const plan = fs.readFileSync(path.join(server.vaultDir, TODAY_PLAN_PATH), 'utf8');
      expect(plan).toContain(
        '-> innkeeper: Thanks. Two things:\n- check the side room\n- confirm the cleaner\n\n<!-- ROLE:innkeeper:END -->'
      );

      // Rendered in the innkeeper card as a "You" bubble holding a
      // paragraph and a list, after the card's latest report.
      const bubble = await page.$eval('#role-innkeeper .role-card-body > .role-you:last-of-type', el => ({
        label: el.querySelector('.role-you-label').textContent,
        paragraph: el.querySelector('p').textContent.trim(),
        items: [...el.querySelectorAll('li')].map(li => li.textContent.trim())
      }));
      expect(bubble).toEqual({
        label: 'You',
        paragraph: 'Thanks. Two things:',
        items: ['check the side room', 'confirm the cleaner']
      });
    } finally {
      await page.close();
    }
  });
});

describe('needs you', () => {
  test("ticking an item in the strip ticks the same item in its role's card", async () => {
    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await page.goto(`${server.baseUrl}/diary/2026-01-15.md`, { waitUntil: 'networkidle0' });
      const strip = await page.$$eval('.role-needs li', items => items.map(li => li.textContent.replace(/\s+/g, ' ').trim()));
      expect(strip).toHaveLength(2);
      expect(strip[0]).toMatch(/^Reply to the listing inquiry for next week.*Innkeeper$/);

      const line = await page.$eval('.role-needs li:nth-child(2) input.task-checkbox', el => el.dataset.line);
      const cardBox = `#role-innkeeper .role-card-body input.task-checkbox[data-line="${line}"]`;
      expect(await page.$eval(cardBox, el => el.checked)).toBe(false);

      await page.click('.role-needs li:nth-child(2) input.task-checkbox');
      await page.waitForFunction(selector => document.querySelector(selector)?.checked, { timeout: 15_000 }, cardBox);
      expect(await page.$$eval('.role-needs li', items => items.length)).toBe(1);
    } finally {
      await page.close();
    }
  });
});

describe('pomodoro banner', () => {
  // The buttons are the only stable hook that distinguishes the pomodoro
  // banner from the task timer's, which also offers a Start.
  const control = (action) => `[onclick*="pomodoro/${action}"]`;

  async function openPage() {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
    await page.goto(`${server.baseUrl}/notes/kitchen-sink.md`, { waitUntil: 'networkidle0' });
    return page;
  }

  async function press(page, action) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.click(control(action))
    ]);
  }

  // The banner, whichever of its three states is showing.
  function bannerText(page) {
    return page.$eval(
      '[data-pomodoro-start], [data-pomodoro-awaiting], [onclick*="pomodoro/start"]',
      el => el.closest('[role="alert"]').textContent.replace(/\s+/g, ' ').trim()
    );
  }

  test('starts, pauses, resumes, skips and stops from the page', async () => {
    const page = await openPage();
    try {
      // Idle: the configured schedule is on show.
      expect(await bannerText(page)).toContain('Pomodoro');
      expect(await bannerText(page)).toContain('2 × 25 min');

      await press(page, 'start');
      expect(await bannerText(page)).toContain('Work period 1 of 2');
      expect(await page.$eval('[data-pomodoro-total-seconds]',
        el => el.dataset.pomodoroTotalSeconds)).toBe('1500');

      // The countdown is driven by the page's own script.
      const first = await page.$eval('.pomodoro-countdown', el => el.textContent);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const second = await page.$eval('.pomodoro-countdown', el => el.textContent);
      expect(second).not.toBe(first);

      await press(page, 'pause');
      expect(await page.$('[data-pomodoro-paused]')).not.toBeNull();
      expect(await bannerText(page)).toContain('Paused');

      await press(page, 'resume');
      expect(await page.$('[data-pomodoro-paused]')).toBeNull();

      await press(page, 'skip');
      expect(await bannerText(page)).toContain('Short rest');

      await press(page, 'skip');
      expect(await bannerText(page)).toContain('Work period 2 of 2');

      await press(page, 'stop');
      expect(await bannerText(page)).toContain('Pomodoro');
      expect(await page.$('[data-pomodoro-total-seconds]')).toBeNull();
    } finally {
      await page.close();
    }
  });
});

describe('timer banner', () => {
  test("shows the configured vault's running timer, so the audits cover it", async () => {
    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await page.goto(`${server.baseUrl}/notes/kitchen-sink.md`, { waitUntil: 'networkidle0' });
      expect(await page.$eval('.alert-info[data-timer-start]', el => el.textContent)).toContain('Write the accessibility tests');
    } finally {
      await page.close();
    }
  });
});
