/**
 * Today's own files inside the vault: where they are looked for, and what the
 * app is willing to read out of them.
 *
 * Two things here are worth guarding. The first is the search order, because
 * it is what lets a vault written before `today/` existed keep working — a
 * regression would silently stop finding a user's palette or quotes. The
 * second is that these files arrive over whatever syncs the vault, so what
 * comes out of them ends up in a page: a link target is checked before it is
 * offered as one.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  APP_DIRNAME,
  appPathCandidates,
  resolveAppPath,
  parseVaultLinks,
  parseVaultQuotes,
  isSafeLinkTarget,
  readVaultLinks,
  readVaultQuotes,
  clearVaultAppFileCache
} from '../src/vault-app-files.js';
import { getAppDirectory, clearConfigCache } from '../src/config.js';

let vaultDir;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-app-files-'));
  clearVaultAppFileCache();
});

afterEach(async () => {
  clearVaultAppFileCache();
  await fs.rm(vaultDir, { recursive: true, force: true });
});

async function write(relativePath, contents) {
  const file = path.join(vaultDir, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, 'utf-8');
  return file;
}

describe('where a file is looked for', () => {
  test('the app directory wins, and the vault root is the fallback', async () => {
    const atRoot = await write('links.md', '- [Old](https://example.com)\n');
    expect(resolveAppPath(vaultDir, 'links.md')).toBe(atRoot);

    const inAppDir = await write(`${APP_DIRNAME}/links.md`, '- [New](https://example.com)\n');
    expect(resolveAppPath(vaultDir, 'links.md')).toBe(inAppDir);
  });

  test('neither being there names the app directory, not the old place', () => {
    expect(resolveAppPath(vaultDir, 'quotes.md'))
      .toBe(path.join(vaultDir, APP_DIRNAME, 'quotes.md'));
  });

  test('an empty app directory keeps everything at the vault root', async () => {
    await write(`${APP_DIRNAME}/links.md`, '- [New](https://example.com)\n');
    expect(appPathCandidates(vaultDir, 'links.md', '')).toEqual([path.join(vaultDir, 'links.md')]);
    expect(resolveAppPath(vaultDir, 'links.md', '')).toBe(path.join(vaultDir, 'links.md'));
  });

  test('the directory is configurable, not only on or off', async () => {
    const elsewhere = await write('.today/links.md', '- [New](https://example.com)\n');
    expect(resolveAppPath(vaultDir, 'links.md', '.today')).toBe(elsewhere);
  });

  // A vault that has not been tidied yet is the state every existing vault is
  // in, so this is the case that must not break.
  test('a vault that never moved its files still reads them', async () => {
    await write('quotes.md', '- A thing — Someone\n');
    const { value } = await readVaultQuotes(vaultDir);
    expect(value).toEqual([{ text: 'A thing', author: 'Someone' }]);
  });
});

describe('holding them', () => {
  test('an edit is picked up without a restart', async () => {
    await write(`${APP_DIRNAME}/links.md`, '- [One](https://example.com)\n');
    expect((await readVaultLinks(vaultDir)).value).toEqual([
      { label: 'One', href: 'https://example.com' }
    ]);

    await write(`${APP_DIRNAME}/links.md`, '- [One](https://example.com)\n- [Two](https://example.org)\n');
    expect((await readVaultLinks(vaultDir)).value).toHaveLength(2);
  });

  // The stamp is handed out as an ETag, so a file that has not changed has to
  // keep its stamp -- otherwise every page load re-sends a list that is the
  // same as the one the browser already has.
  test('an unchanged file keeps its stamp', async () => {
    await write(`${APP_DIRNAME}/links.md`, '- [One](https://example.com)\n');
    const first = await readVaultLinks(vaultDir);
    const second = await readVaultLinks(vaultDir);
    expect(second.stamp).toBe(first.stamp);
    expect(first.stamp).not.toBe('');
  });

  // Moving a file into the app directory changes where it is without changing
  // what it says. A cache keyed on mtime alone would serve the old parse.
  test('moving a file between the two places is noticed', async () => {
    // Given the same mtime on purpose. Writing them a moment apart would make
    // the stamps differ whether or not the place is part of them, which is
    // the regression this is here to catch.
    const when = new Date('2026-01-01T00:00:00Z');
    const atRootFile = await write('links.md', '- [Old](https://example.com)\n');
    await fs.utimes(atRootFile, when, when);
    const atRoot = await readVaultLinks(vaultDir);
    expect(atRoot.value).toEqual([{ label: 'Old', href: 'https://example.com' }]);

    const inAppDirFile = await write(`${APP_DIRNAME}/links.md`, '- [New](https://example.org)\n');
    await fs.utimes(inAppDirFile, when, when);
    const inAppDir = await readVaultLinks(vaultDir);
    expect(inAppDir.value).toEqual([{ label: 'New', href: 'https://example.org' }]);
    expect(inAppDir.stamp).not.toBe(atRoot.stamp);
  });

  test('no file at all is a normal state, with a stamp of its own', async () => {
    const { value, stamp } = await readVaultLinks(vaultDir);
    expect(value).toEqual([]);
    expect(stamp).toBe('');
  });
});

describe('what a links file may say', () => {
  test('an unordered list of markdown links, in the order written', () => {
    expect(parseVaultLinks([
      '# Links',
      '',
      'Some prose, which is not a link.',
      '- [GitHub](https://github.com)',
      '* [OlderGay.Men](https://oldergay.men)',
      ''
    ].join('\n'))).toEqual([
      { label: 'GitHub', href: 'https://github.com' },
      { label: 'OlderGay.Men', href: 'https://oldergay.men' }
    ]);
  });

  test("markdown's optional link title is allowed, and dropped", () => {
    expect(parseVaultLinks('- [GitHub](https://github.com "Where the code is")\n'))
      .toEqual([{ label: 'GitHub', href: 'https://github.com' }]);
  });

  test('a vault path is a link too, since the panel is served from the vault', () => {
    expect(parseVaultLinks('- [Tasks](/tasks/today.md)\n- [Notes](notes/index.md)\n'))
      .toEqual([
        { label: 'Tasks', href: '/tasks/today.md' },
        { label: 'Notes', href: 'notes/index.md' }
      ]);
  });

  // The file looks like notes and arrives over whatever syncs the vault. A
  // script target in it is not something the calm panel should be the one to
  // honour, so it never reaches an href.
  test('a scheme we will not put in an href is dropped, not rendered', () => {
    expect(isSafeLinkTarget('javascript:alert(1)')).toBe(false);
    expect(isSafeLinkTarget('JavaScript:alert(1)')).toBe(false);
    expect(isSafeLinkTarget('data:text/html,<script>')).toBe(false);
    expect(isSafeLinkTarget('vbscript:msgbox')).toBe(false);
    expect(isSafeLinkTarget('//evil.example.com')).toBe(false);
    expect(isSafeLinkTarget('\u0001javascript:alert(1)')).toBe(false);
    expect(isSafeLinkTarget('\\evil.example.com/path')).toBe(false);
    expect(isSafeLinkTarget('\\\\evil.example.com/path')).toBe(false);

    expect(isSafeLinkTarget('https://example.com')).toBe(true);
    expect(isSafeLinkTarget('http://example.com')).toBe(true);
    expect(isSafeLinkTarget('mailto:someone@example.com')).toBe(true);

    // Deliberately without brackets of its own: a payload containing them
    // never reaches the check, because the link pattern rejects it first,
    // which would make this assertion pass for the wrong reason.
    expect(parseVaultLinks([
      '- [Fine](https://example.com)',
      '- [Not fine](javascript:alert)',
      '- [Hidden control](\u0001javascript:alert`1`)',
      '- [C1 control](https://exa\u0085mple.com)',
      '- [Backslash host](\\\\evil.example.com/path)',
      '- [Mixed slash host](\\/evil.example.com/path)'
    ].join('\n'))).toEqual([{ label: 'Fine', href: 'https://example.com' }]);
  });

  test('a line that is not a link is left alone', () => {
    expect(parseVaultLinks('- just text\n- [](https://example.com)\n- [Label]()\n')).toEqual([]);
  });
});

describe('what a quotes file may say', () => {
  test('text and author, split on the last em dash', () => {
    expect(parseVaultQuotes('- A thing — well put — Someone\n')).toEqual([
      { text: 'A thing — well put', author: 'Someone' }
    ]);
  });

  test('an author is optional', () => {
    expect(parseVaultQuotes('- A thing\n')).toEqual([{ text: 'A thing', author: '' }]);
  });
});

// ── Where the app directory's name comes from ──────────────────────────────
// The resolution above is tested with the name handed in; this is the one
// place the name is actually decided, and its contract has a sharp edge:
// unset means `today`, but an empty string means the vault root, which a
// `configured || APP_DIRNAME` would silently turn back into `today`.

describe('getAppDirectory', () => {
  let workDir;
  let previousConfig;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-directory-'));
    previousConfig = process.env.TODAY_CONFIG;
  });

  afterEach(async () => {
    if (previousConfig === undefined) delete process.env.TODAY_CONFIG;
    else process.env.TODAY_CONFIG = previousConfig;
    clearConfigCache();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  async function withConfig(body) {
    const file = path.join(workDir, 'config.toml');
    await fs.writeFile(file, body);
    process.env.TODAY_CONFIG = file;
    clearConfigCache();
    return getAppDirectory();
  }

  test('unset means the default directory', async () => {
    expect(await withConfig('vault_path = "vault"\n')).toBe(APP_DIRNAME);
  });

  test('an empty string means the vault root, and is not a missing value', async () => {
    expect(await withConfig('vault_path = "vault"\napp_directory = ""\n')).toBe('');
  });

  test('a name is taken as given', async () => {
    expect(await withConfig('vault_path = "vault"\napp_directory = ".today"\n')).toBe('.today');
  });
});
