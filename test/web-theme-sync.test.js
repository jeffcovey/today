/**
 * The theme is stored on the server, so a choice made in one browser is the
 * theme a different browser opens in — applied before first paint, with no
 * flash of the other theme.
 */

import { jest } from '@jest/globals';
import puppeteer from 'puppeteer';
import { startServer, PASSWORD } from './helpers/a11y-harness.js';

jest.setTimeout(180_000);

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

/** A browser that has never been here: its own cookie jar and storage. */
async function freshDevice() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
  return { context, page };
}

async function themeOf(page) {
  return page.evaluate(() => document.documentElement.dataset.theme);
}

describe('the theme follows the person, not the browser', () => {
  test('a choice on one device is what the next device opens in', async () => {
    const first = await freshDevice();
    const second = await freshDevice();
    try {
      // The system preference is light on both, so only the stored choice can
      // make either of them dark.
      await first.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await second.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

      await first.page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
      expect(await themeOf(first.page)).toBe('light');

      await first.page.evaluate(() => window.setThemeMode('dark'));
      await first.page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');

      // A browser with no cookie and no localStorage of its own.
      await second.page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
      expect(await themeOf(second.page)).toBe('dark');
      expect(await second.page.evaluate(() => localStorage.getItem('todayThemeMode'))).toBe('dark');
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  test('the stored theme is applied before the page paints, not after', async () => {
    const setter = await freshDevice();
    try {
      await setter.page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
      await setter.page.evaluate(() => window.setThemeMode('dark'));
      await setter.page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    } finally {
      await setter.context.close();
    }

    const { context, page } = await freshDevice();
    try {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      // Record the theme as the very first element is parsed: anything set
      // later than this would be visible to the eye as a flash.
      // `document` is the only node that exists this early: at document-start
      // `document.documentElement` is still null.
      await page.evaluateOnNewDocument(() => {
        new MutationObserver((_records, observer) => {
          if (document.body) {
            window.__themeAtBodyStart = document.documentElement.dataset.theme || null;
            observer.disconnect();
          }
        }).observe(document, { childList: true, subtree: true });
      });

      await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
      expect(await page.evaluate(() => window.__themeAtBodyStart)).toBe('dark');
    } finally {
      await context.close();
    }
  });

  test('the login page carries the theme too, being the first page a device sees', async () => {
    const setter = await freshDevice();
    try {
      await setter.page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
      await setter.page.evaluate(() => window.setThemeMode('dark'));
      await setter.page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    } finally {
      await setter.context.close();
    }

    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      // No Authorization header: this is the logged-out view.
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await page.goto(server.baseUrl + '/auth/login', { waitUntil: 'networkidle0' });

      expect(await page.$('form')).not.toBeNull();
      expect(await themeOf(page)).toBe('dark');
    } finally {
      await context.close();
    }
  });

  test('the API rejects a mode the display does not offer', async () => {
    const { context, page } = await freshDevice();
    try {
      await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
      const result = await page.evaluate(async () => {
        const response = await fetch('/api/theme', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'chartreuse' })
        });
        return { status: response.status, body: await response.json() };
      });

      expect(result.status).toBe(400);
      expect(result.body.success).toBe(false);

      const stored = await page.evaluate(async () => (await (await fetch('/api/theme')).json()).mode);
      expect(stored).not.toBe('chartreuse');
    } finally {
      await context.close();
    }
  });
});
