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
  usePalette,
  PASSWORD,
  PAGES,
  THEMES,
  TODAY_PLAN_PATH,
  VIEWPORTS
} from './helpers/a11y-harness.js';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

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
      await useTheme(page, 'dark', server.baseUrl);
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
      await useTheme(page, first, server.baseUrl);
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await page.goto(`${server.baseUrl}/_git`, { waitUntil: 'networkidle0' });
      expect(await page.$eval('html', el => el.dataset.theme)).toBe(first);
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
      expect(await page.$eval('html', el => el.dataset.theme)).toBe(second);
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
      await useTheme(page, theme, server.baseUrl);
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await page.goto(server.baseUrl + PAGES.find(p => p.name === name).path, { waitUntil: 'networkidle0' });
      expect(await page.$eval('html', el => el.dataset.theme)).toBe(theme);
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

// A palette from the vault replaces the colours every other audit above runs
// against, so it gets its own pass. The fixture vault's themes/cocoa.toml is
// contrast-tuned the same way Today's palette is, which is what makes this a
// test of the mechanism rather than of that one file: if the server ever
// stopped serving a vault palette, or served it without the --mdb-* bridge
// properties, these pages would come out in colours nobody tuned and axe
// would say so.
describe('a palette from the vault', () => {
  const page = PAGES.find(p => p.name === 'kitchen-sink');

  afterAll(async () => {
    await usePalette('today', server.baseUrl);
  });

  test('is offered alongside the built-in one', async () => {
    const response = await fetch(`${server.baseUrl}/api/themes`, {
      headers: { Authorization: `Bearer ${PASSWORD}` }
    });
    expect(response.ok).toBe(true);
    const { themes, selected } = await response.json();
    expect(themes).toEqual([
      { id: 'today', name: 'Today' },
      { id: 'cocoa', name: 'Cocoa' },
      { id: 'light-brand', name: 'Light brand' }
    ]);
    expect(selected).toBe('today');
  });

  test('is served as a stylesheet that only sets colours', async () => {
    await usePalette('cocoa', server.baseUrl);
    const response = await fetch(`${server.baseUrl}/theme.css`);
    expect(response.ok).toBe(true);
    const css = await response.text();
    expect(css).toContain(':root {');
    expect(css).toContain('html[data-theme="dark"] {');
    expect(css).toContain('--today-bg: rgb(246, 241, 234);');
    // The bridges MDB reads for links and for the brand fill, which
    // style.css cannot express as a var() because MDB composes them as
    // rgba(var(--…-rgb), a).
    expect(css).toContain('--mdb-link-color-rgb: 138, 75, 20;');
    expect(css).toContain('--mdb-primary-rgb: 122, 66, 16;');
    expect(css).toContain('--mdb-primary-rgb: 161, 85, 26;');
    // Only custom properties, one per line, and no way out of the block.
    for (const line of css.split('\n')) {
      const body = line.trim();
      if (!body || body.startsWith('/*') || body.endsWith('{') || body === '}') continue;
      expect(body).toMatch(/^--[a-z0-9-]+: [^;{}]+;$/);
    }
  });

  test('revalidates instead of being cached, so a change shows up', async () => {
    await usePalette('cocoa', server.baseUrl);
    const first = await fetch(`${server.baseUrl}/theme.css`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(first.headers.get('cache-control')).toBe('no-cache');

    const unchanged = await fetch(`${server.baseUrl}/theme.css`, {
      headers: { 'If-None-Match': etag }
    });
    expect(unchanged.status).toBe(304);

    await usePalette('today', server.baseUrl);
    const changed = await fetch(`${server.baseUrl}/theme.css`, {
      headers: { 'If-None-Match': etag }
    });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe('');
  });

  test('an unknown palette is refused rather than stored', async () => {
    const response = await fetch(`${server.baseUrl}/api/theme`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PASSWORD}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-such-palette' })
    });
    expect(response.status).toBe(400);
  });

  test('shows up in the display menu, and choosing it repaints the page', async () => {
    await usePalette('today', server.baseUrl);
    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      // The mode is server-wide and the audits above leave it wherever they
      // finished, so this names the one it is checking a colour from.
      await useTheme(page, 'light', server.baseUrl);
      await page.goto(`${server.baseUrl}/notes/kitchen-sink.md`, { waitUntil: 'networkidle0' });

      // The row is filled in from /api/themes after load, not rendered into
      // the page, because pages are cached to disk.
      await page.waitForFunction(() => !document.getElementById('paletteRow').hidden);
      expect(await page.$$eval('#paletteSelect option', options =>
        options.map(option => [option.value, option.textContent]))).toEqual([
        ['today', 'Today'],
        ['cocoa', 'Cocoa'],
        ['light-brand', 'Light brand']
      ]);

      const before = await page.evaluate(() =>
        getComputedStyle(document.body).backgroundColor);
      await page.select('#paletteSelect', 'cocoa');
      await page.waitForFunction(() =>
        getComputedStyle(document.body).backgroundColor === 'rgb(246, 241, 234)');

      expect(before).not.toBe('rgb(246, 241, 234)');
      // And it stuck: a fresh load comes up in it with no repaint.
      const other = await browser.newPage();
      try {
        await other.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
        await useTheme(other, 'light', server.baseUrl);
        await other.goto(`${server.baseUrl}/notes/kitchen-sink.md`, { waitUntil: 'networkidle0' });
        expect(await other.evaluate(() =>
          getComputedStyle(document.body).backgroundColor)).toBe('rgb(246, 241, 234)');
      } finally {
        await other.close();
      }
    } finally {
      await page.close();
    }
  });

  // The navbar is the thing a palette most visibly has to reach, and it is
  // MDB's .bg-primary: rgba(var(--mdb-primary-rgb), var(--mdb-bg-opacity)).
  // That composition is why the triple is emitted as digits rather than as a
  // var() — a var() colour cannot feed an rgba(). Both halves are checked
  // here: the fill at full opacity, and a tint of it, which is the case that
  // would silently come out transparent if the triple were ever a var().
  const BRAND_FILL = { light: 'rgb(122, 66, 16)', dark: 'rgb(161, 85, 26)' };

  test.each(THEMES)('%s theme: the vault\'s brand fill reaches the navbar', async (theme) => {
    const view = await browser.newPage();
    try {
      await view.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
      await useTheme(view, theme, server.baseUrl);

      const brandColours = () => view.evaluate(() => {
        // Nothing Today renders carries bg-opacity today, so the tint is
        // built here rather than hunted for: it is the construction the
        // literal triple exists for.
        const tint = document.createElement('div');
        tint.className = 'bg-primary bg-opacity-10';
        document.body.appendChild(tint);
        const colours = {
          navbar: getComputedStyle(document.querySelector('.navbar.bg-primary')).backgroundColor,
          tint: getComputedStyle(tint).backgroundColor
        };
        tint.remove();
        return colours;
      });

      await usePalette('today', server.baseUrl);
      await view.goto(`${server.baseUrl}/notes/kitchen-sink.md`, { waitUntil: 'networkidle0' });
      // The built-in palette holds MDB's own primary, so bridging it moved
      // nothing: this is the colour the navbar had before the bridge existed.
      expect(await brandColours()).toEqual({
        navbar: 'rgb(59, 113, 202)',
        tint: 'rgba(59, 113, 202, 0.1)'
      });

      await usePalette('cocoa', server.baseUrl);
      await view.reload({ waitUntil: 'networkidle0' });
      const fill = BRAND_FILL[theme];
      expect(await brandColours()).toEqual({
        navbar: fill,
        tint: fill.replace('rgb(', 'rgba(').replace(')', ', 0.1)')
      });
    } finally {
      await view.close();
    }
  });

  test.each(THEMES.flatMap(theme =>
    ['markdown-diary', 'markdown-plans'].map(plugin => [theme, plugin])
  ))('%s theme, %s: non-white brand ink reaches filled surfaces', async (theme, plugin) => {
    const brandServer = await startServer({
      configLines: [`[plugins.${plugin}.default]`, 'enabled = true']
    });
    const { baseUrl } = brandServer;
    const view = await browser.newPage();
    const ink = theme === 'light' ? 'rgb(36, 24, 0)' : 'rgb(16, 32, 64)';
    try {
      await usePalette('light-brand', baseUrl);
      await view.setExtraHTTPHeaders({ Authorization: 'Bearer ' + PASSWORD });
      await useTheme(view, theme, baseUrl);
      await view.goto(baseUrl, { waitUntil: 'networkidle0' });

      const tile = '.list-group-item.bg-primary';
      const colors = {
        tile: await view.$eval(tile, el => getComputedStyle(el).color),
        header: await view.$eval('#aiAssistantHeader', el => getComputedStyle(el).color),
        chevron: await view.$eval('#aiAssistantHeader .toggle-btn #toggleIcon', el => getComputedStyle(el).color)
      };
      await view.hover(tile);
      colors.hoveredTile = await view.$eval(tile, el => getComputedStyle(el).color);

      await view.goto(`${baseUrl}/_git`, { waitUntil: 'networkidle0' });
      await openDiff(view, 'code/example.js');
      colors.activeFile = await view.$eval('.file-item.active', el => new Promise(resolve => {
        let previous;
        const sample = () => {
          const color = getComputedStyle(el).color;
          if (color === previous) {
            resolve(color);
          } else {
            previous = color;
            requestAnimationFrame(sample);
          }
        };
        requestAnimationFrame(sample);
      }));
      colors.activeFileText = await view.$$eval('.file-item.active span', els =>
        els.map(el => getComputedStyle(el).color));

      // Exercise MDB's badge colour variable, not just inherited surface ink.
      colors.badge = await view.evaluate(() => {
        const badge = document.createElement('span');
        badge.className = 'badge bg-primary';
        badge.textContent = 'Open';
        document.body.appendChild(badge);
        const color = getComputedStyle(badge).color;
        badge.remove();
        return color;
      });
      expect(colors).toEqual({
        tile: ink, hoveredTile: ink, header: ink, chevron: ink,
        activeFile: ink, activeFileText: [ink], badge: ink
      });
    } finally {
      await view.close();
      await brandServer.stop();
    }
  });

  test.each(THEMES.flatMap(theme =>
    ['today', 'cocoa'].map(palette => [theme, palette])
  ))('%s theme, %s palette: task-source ink follows the link token, not the brand fill', async (theme, palette) => {
    const db = new Database(path.join(path.dirname(server.vaultDir), '.data', 'today.db'));
    const taskId = 'brand-source-link-test';
    const view = await browser.newPage();
    try {
      db.prepare('INSERT INTO tasks (id, source, title, status, metadata) VALUES (?, ?, ?, ?, ?)').run(
        taskId, 'test/source', 'Task with a source file', 'open',
        JSON.stringify({ file_path: 'vault/notes/kitchen-sink.md' })
      );
      await usePalette(palette, server.baseUrl);
      await view.setExtraHTTPHeaders({ Authorization: 'Bearer ' + PASSWORD });
      await useTheme(view, theme, server.baseUrl);
      await view.goto(`${server.baseUrl}/task/${taskId}`, { waitUntil: 'networkidle0' });
      expect(await view.$('.text-primary')).toBeNull();

      const colors = await view.$eval('a[href="/notes/kitchen-sink.md"]', el => {
        const probe = document.createElement('span');
        el.appendChild(probe);
        probe.style.color = 'var(--today-link)';
        const link = getComputedStyle(probe).color;
        probe.style.color = 'var(--today-brand-bg)';
        const brand = getComputedStyle(probe).color;
        probe.remove();
        return { actual: getComputedStyle(el).color, link, brand };
      });
      expect(colors.actual).toBe(colors.link);
      expect(colors.actual).not.toBe(colors.brand);
    } finally {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      db.close();
      await view.close();
    }
  });

  test.each(THEMES)('%s theme: no violations with the vault palette applied', async (theme) => {
    await usePalette('cocoa', server.baseUrl);
    const violations = await auditPage(browser, {
      baseUrl: server.baseUrl, page, theme, viewport: 'desktop'
    });
    expect(violations.map(describeViolation)).toEqual([]);
  });
});
