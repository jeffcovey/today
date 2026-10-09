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
