/**
 * Regression guard: every /static/<path> URL emitted by the web server must
 * carry a cache-busting version query string. Without this, browsers serve
 * stale assets for up to express.static's max-age (currently 1 day) after a
 * deploy — which previously broke the theme toggle when the post-#258 HTML
 * was loaded against the pre-#258 cached common.js (see #287).
 *
 * This test scans HTML templates and web-server.js for /static/ refs and
 * asserts each one is followed by `?v={{staticVersion}}` (template) or
 * `?v=${STATIC_VERSION}` (server-rendered HTML in web-server.js).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const templatesDir = path.join(projectRoot, 'src', 'web', 'templates');
const webServerPath = path.join(projectRoot, 'src', 'web-server.js');

// Matches /static/<anything> followed by what comes next up to the closing quote.
// We assert the full URL (with version) survives, so we capture everything up to
// the closing quote / whitespace.
const STATIC_URL_RE = /\/static\/[^"'\s>]*/g;

function collectStaticUrls(text) {
  return [...text.matchAll(STATIC_URL_RE)].map(match => match[0]);
}

describe('static asset cache busting', () => {
  const templateFiles = fs.readdirSync(templatesDir)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(templatesDir, f));

  test('every HTML template was discovered (at least one)', () => {
    expect(templateFiles.length).toBeGreaterThan(0);
  });

  test.each(templateFiles)('%s: every /static/ ref carries ?v={{staticVersion}}', (file) => {
    const content = fs.readFileSync(file, 'utf8');
    const urls = collectStaticUrls(content);
    // Some templates legitimately have no static refs; only assert versioning
    // on the ones that do.
    for (const url of urls) {
      expect(url).toMatch(/\?v=\{\{staticVersion\}\}$/);
    }
  });

  test('web-server.js: every /static/ ref carries ?v=${STATIC_VERSION}', () => {
    const content = fs.readFileSync(webServerPath, 'utf8');
    const urls = collectStaticUrls(content);
    // Filter out the express.static mount path itself — `/static` (no file)
    // shows up as the mount route and should not have a version stamp.
    const assetUrls = urls.filter(u => u !== '/static' && !u.endsWith('/static/'));
    expect(assetUrls.length).toBeGreaterThan(0);
    for (const url of assetUrls) {
      expect(url).toMatch(/\?v=\$\{STATIC_VERSION\}$/);
    }
  });
});
