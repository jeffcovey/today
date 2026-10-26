/**
 * Themes the user keeps in their vault: what a theme file may say, and what
 * happens to a file that says something else. These files are hand-written
 * and their values end up inside a CSS response, so the cases that matter
 * most here are the ones where a file is wrong.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  parseColor,
  buildTheme,
  renderThemeCss,
  readVaultThemes,
  listThemes,
  getThemeStylesheet,
  clearVaultThemesCache,
  THEME_TOKENS,
  BUILT_IN_THEME_ID
} from '../src/web/themes.js';

let vaultDir;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-themes-'));
  clearVaultThemesCache();
});

afterEach(async () => {
  clearVaultThemesCache();
  await fs.rm(vaultDir, { recursive: true, force: true });
});

async function writeTheme(name, contents) {
  const themesDir = path.join(vaultDir, 'themes');
  await fs.mkdir(themesDir, { recursive: true });
  await fs.writeFile(path.join(themesDir, name), contents, 'utf-8');
}

test('source never uses the brand fill as text-primary foreground ink', async () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const consumers = [];
  for (const file of await fs.readdir(srcDir, { recursive: true })) {
    if (!/\.(js|css|html)$/.test(file)) continue;
    const source = await fs.readFile(path.join(srcDir, file), 'utf8');
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (/\btext-primary\b/.test(withoutComments)) consumers.push(file);
  }
  expect(consumers).toEqual([]);
});

// The two vocabularies: FAMILY says what a thing is, STATUS says how it went.
// The rule that keeps them useful is that a family colour is never ink -- it
// is a stripe and a wash, with body ink on top -- which is also what frees it
// from any contrast floor. Documented in README.md; asserted here, because a
// rule that lives only in a comment gets rediscovered instead of followed.
describe('family and status stay separate', () => {
  const cssPath = fileURLToPath(new URL('../src/web/public/css/style.css', import.meta.url));

  test('a family colour is never used as ink', async () => {
    const css = await fs.readFile(cssPath, 'utf8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // Every `color:` / `-webkit-text-fill-color:` declaration, wherever it
    // sits -- a one-line rule puts it after the brace, not at line start,
    // which is what an earlier version of this test missed. The leading
    // boundary is what keeps `background-color` and `border-color` out.
    // Catch both --today-family-* tokens and the cards' --family alias.
    const declaration = /(?:^|[\s;{])(?:-webkit-text-fill-)?color\s*:\s*([^;}]*)/g;
    const inkUses = [];
    for (const match of withoutComments.matchAll(declaration)) {
      if (/--(?:today-family-|family\b)/.test(match[1])) inkUses.push(match[0].trim());
    }
    expect(inkUses).toEqual([]);
  });

  test('the two sets share no token', () => {
    const families = THEME_TOKENS.filter(token => token.startsWith('family-'));
    const statuses = THEME_TOKENS.filter(token => /^(ok|attn|info|err)-/.test(token));
    expect(families.length).toBeGreaterThan(0);
    expect(statuses.length).toBeGreaterThan(0);
    expect(families.filter(token => statuses.includes(token))).toEqual([]);
  });

  test('every family and status token has a value in both modes', async () => {
    const css = await fs.readFile(cssPath, 'utf8');
    const light = css.slice(css.indexOf(':root {'), css.indexOf('html[data-theme="dark"] {'));
    const dark = css.slice(css.indexOf('html[data-theme="dark"] {'));
    const wanted = THEME_TOKENS.filter(
      token => token.startsWith('family-') || /^(ok|attn|info|err)-/.test(token)
    );
    const missing = [];
    for (const token of wanted) {
      if (!light.includes(`--today-${token}:`)) missing.push(`light ${token}`);
      if (!dark.includes(`--today-${token}:`)) missing.push(`dark ${token}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('reading a colour', () => {
  test.each([
    ['#abc', { r: 170, g: 187, b: 204, a: 1 }],
    ['#AABBCC', { r: 170, g: 187, b: 204, a: 1 }],
    ['#aabbcc80', { r: 170, g: 187, b: 204, a: 0.5019607843137255 }],
    ['rgb(1, 2, 3)', { r: 1, g: 2, b: 3, a: 1 }],
    ['rgba(1, 2, 3, 0.5)', { r: 1, g: 2, b: 3, a: 0.5 }],
    ['rgb(1 2 3 / 50%)', { r: 1, g: 2, b: 3, a: 0.5 }],
    ['rgb(100%, 0%, 0%)', { r: 255, g: 0, b: 0, a: 1 }],
    ['hsl(0, 100%, 50%)', { r: 255, g: 0, b: 0, a: 1 }],
    ['hsl(210 50% 40%)', { r: 51, g: 102, b: 153, a: 1 }]
  ])('%s', (input, expected) => {
    expect(parseColor(input)).toEqual(expected);
  });

  // Anything that isn't provably a colour is refused, so there is no way to
  // close the declaration, open a new one, or make the page fetch something.
  test.each([
    ['red'],
    ['url(https://example.com/x.png)'],
    ['#ffffff; background-image: url(https://example.com/x.png)'],
    ['#fff }'],
    ['var(--today-bg)'],
    ['rgb(1, 2)'],
    ['rgb(1, 2, 3, 4, 5)'],
    ['rgb(a, b, c)'],
    ['#12345'],
    [''],
    [42],
    [null]
  ])('%s is not a colour', (input) => {
    expect(parseColor(input)).toBeNull();
  });
});

describe('building a theme', () => {
  test('keeps the tokens it recognises and says what it dropped', () => {
    const { theme, problems } = buildTheme('pride', {
      name: 'Pride',
      light: { bg: '#ffffff', link: '#004cff', bogus: '#000000', text: 'chartreuse' }
    });
    expect(Object.keys(theme.modes.light)).toEqual(['bg', 'link']);
    expect(theme.name).toBe('Pride');
    expect(problems).toEqual([
      '[light] has no token "bogus"',
      '[light] text is not a colour this can read: "chartreuse"'
    ]);
  });

  test('falls back to the file name when there is no name', () => {
    const { theme } = buildTheme('cocoa', { light: { bg: '#ffffff' } });
    expect(theme.name).toBe('cocoa');
  });

  test('a file that sets nothing usable is not a theme', () => {
    const { theme, problems } = buildTheme('empty', { name: 'Empty' });
    expect(theme).toBeNull();
    expect(problems).toContain('sets no colours');
  });

  test('cannot shadow the built-in palette', () => {
    const { theme } = buildTheme(BUILT_IN_THEME_ID, { light: { bg: '#ffffff' } });
    expect(theme).toBeNull();
  });

  test('an id that could escape a URL or a selector is refused', () => {
    for (const id of ['../escape', 'has space', 'quote"', '']) {
      expect(buildTheme(id, { light: { bg: '#ffffff' } }).theme).toBeNull();
    }
  });
});

describe('rendering the stylesheet', () => {
  test('sets only the tokens the theme gave, in both modes', () => {
    const { theme } = buildTheme('cocoa', {
      name: 'Cocoa',
      light: { bg: '#f6f1ea' },
      dark: { bg: '#1b1510' }
    });
    const css = renderThemeCss(theme);
    expect(css).toContain(':root {\n  --today-bg: rgb(246, 241, 234);\n}');
    expect(css).toContain('html[data-theme="dark"] {\n  --today-bg: rgb(27, 21, 16);\n}');
    expect(css).not.toContain('--today-text');
  });

  test('re-emits the MDB properties that cannot be var()', () => {
    const { theme } = buildTheme('cocoa', {
      name: 'Cocoa',
      light: { link: '#8a4b14' },
      dark: { text: '#f2eade' }
    });
    const css = renderThemeCss(theme);
    expect(css).toContain('--mdb-link-color-rgb: 138, 75, 20;');
    expect(css).toContain('--mdb-surface-color-rgb: 242, 234, 222;');
    expect(css).toContain('--mdb-body-color-rgb: 242, 234, 222;');
  });

  // MDB composes .bg-primary — the badges, the AI header — as
  // rgba(var(--mdb-primary-rgb), var(--mdb-bg-opacity)), so the brand fill
  // needs its triple spelled out too, or a palette stops short of them. The
  // navbar used to be the headline case here; it has its own token now, which
  // still defaults to this fill.
  test('the brand fill moves MDB\'s primary, in both modes', () => {
    const { theme } = buildTheme('cocoa', {
      name: 'Cocoa',
      light: { 'brand-bg': '#7a4210', 'brand-text': '#ffffff' },
      // MDB ships no dark override for its primary, so the dark block has to
      // carry the triple itself rather than inherit the light one.
      dark: { 'brand-bg': '#a1551a' }
    });
    const css = renderThemeCss(theme);
    expect(css).toContain('--today-brand-bg: rgb(122, 66, 16);');
    expect(css).toContain('--today-brand-text: rgb(255, 255, 255);');
    expect(css).toContain('--mdb-primary-rgb: 122, 66, 16;');
    expect(css).toContain('--mdb-primary-rgb: 161, 85, 26;');
  });

  // The ink is only ever read through a var(), so it has no triple of its
  // own: a theme that sets it alone has not moved MDB's primary.
  test('the brand ink alone does not move MDB\'s primary', () => {
    const { theme } = buildTheme('cocoa', { light: { 'brand-text': '#ffffff' } });
    const css = renderThemeCss(theme);
    expect(css).toContain('--today-brand-text: rgb(255, 255, 255);');
    expect(css).not.toContain('--mdb-primary-rgb');
  });

  test('a header colour is emitted only when the theme asks for one', () => {
    // The header defaults to the brand fill in style.css, so a palette that
    // names only the brand must not emit a header token -- emitting one would
    // pin the header and quietly break that default for every other palette.
    const brandOnly = buildTheme('cocoa', { light: { 'brand-bg': '#7a4210' } }).theme;
    expect(renderThemeCss(brandOnly)).not.toContain('--today-header-bg');

    const withHeader = buildTheme('cream', {
      light: { 'header-bg': '#fff7ec', 'header-text': '#212529' }
    }).theme;
    const css = renderThemeCss(withHeader);
    expect(css).toContain('--today-header-bg: rgb(255, 247, 236);');
    expect(css).toContain('--today-header-text: rgb(33, 37, 41);');
    // And it is its own token: naming the header must not move MDB's primary,
    // which is what the badges and border-primary are drawn from.
    expect(css).not.toContain('--mdb-primary-rgb');
  });

  test('alpha survives', () => {
    const { theme } = buildTheme('cocoa', { light: { overlay: 'rgba(255, 253, 249, 0.9)' } });
    expect(renderThemeCss(theme)).toContain('--today-overlay: rgba(255, 253, 249, 0.9);');
  });

  test('every token in the vocabulary can be set', () => {
    const light = Object.fromEntries(THEME_TOKENS.map(token => [token, '#123456']));
    const { theme, problems } = buildTheme('all', { light });
    expect(problems).toEqual([]);
    expect(Object.keys(theme.modes.light)).toEqual(THEME_TOKENS);
  });
});

describe('reading the vault', () => {
  test('a vault with no themes directory simply has none', async () => {
    expect(await listThemes(vaultDir)).toEqual([{ id: BUILT_IN_THEME_ID, name: 'Today' }]);
  });

  test('a theme file is offered, and served as a stylesheet', async () => {
    await writeTheme('cocoa.toml', 'name = "Cocoa"\n\n[light]\nbg = "#f6f1ea"\n');
    expect(await listThemes(vaultDir)).toEqual([
      { id: BUILT_IN_THEME_ID, name: 'Today' },
      { id: 'cocoa', name: 'Cocoa' }
    ]);
    const { css } = await getThemeStylesheet(vaultDir, 'cocoa');
    expect(css).toContain('--today-bg: rgb(246, 241, 234);');
  });

  test('a palette that is gone falls back to the built-in one', async () => {
    const { css, theme } = await getThemeStylesheet(vaultDir, 'deleted');
    expect(theme).toBeNull();
    expect(css).toBe('');
  });

  test('a file that is not valid TOML is skipped, not fatal', async () => {
    await writeTheme('broken.toml', 'name = "Broken\n[light\n');
    await writeTheme('cocoa.toml', 'name = "Cocoa"\n\n[light]\nbg = "#f6f1ea"\n');
    const { themes, problems } = await readVaultThemes(vaultDir);
    expect([...themes.keys()]).toEqual(['cocoa']);
    expect(problems.get('broken.toml')[0]).toMatch(/not valid TOML/);
  });

  test('an edit is picked up without a restart', async () => {
    await writeTheme('cocoa.toml', 'name = "Cocoa"\n\n[light]\nbg = "#f6f1ea"\n');
    expect((await getThemeStylesheet(vaultDir, 'cocoa')).css).toContain('rgb(246, 241, 234)');
    // A different length as well as a different mtime, because the cache is
    // keyed on both and a same-millisecond rewrite of the same size is not a
    // change it can see.
    await writeTheme('cocoa.toml', 'name = "Cocoa"\n\n[light]\nbg = "#000"\n');
    expect((await getThemeStylesheet(vaultDir, 'cocoa')).css).toContain('rgb(0, 0, 0)');
  });
});
