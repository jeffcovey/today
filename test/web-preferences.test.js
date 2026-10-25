/**
 * The shared display preferences behind the web view's theme: stored on the
 * server so every device agrees, and safe to read when the file is missing,
 * unreadable or has been edited into nonsense by hand.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  readWebPreferences,
  getStoredThemeMode,
  setStoredThemeMode,
  getStoredThemeName,
  setStoredThemeName,
  clearWebPreferencesCache,
  getPreferencesPath,
  isThemeMode,
  THEME_MODES,
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_NAME
} from '../src/web-preferences.js';

let workDir;
let originalPath;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-prefs-'));
  originalPath = process.env.TODAY_WEB_PREFERENCES;
  process.env.TODAY_WEB_PREFERENCES = path.join(workDir, 'web-preferences.json');
  clearWebPreferencesCache();
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.TODAY_WEB_PREFERENCES;
  else process.env.TODAY_WEB_PREFERENCES = originalPath;
  clearWebPreferencesCache();
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('web preferences', () => {
  test('a missing file reads as the default theme', async () => {
    expect(await getStoredThemeMode()).toBe(DEFAULT_THEME_MODE);
    expect(await readWebPreferences()).toEqual({ themeMode: 'system', themeName: 'today' });
  });

  test('stores and reads back a palette, and refuses one that is not an id', async () => {
    await setStoredThemeName('cocoa');
    expect(await getStoredThemeName()).toBe('cocoa');
    await expect(setStoredThemeName('../escape')).rejects.toThrow();
    expect(await getStoredThemeName()).toBe('cocoa');
  });

  test('the mode and the palette do not overwrite each other', async () => {
    await setStoredThemeName('cocoa');
    await setStoredThemeMode('dark');
    expect(await readWebPreferences()).toEqual({ themeMode: 'dark', themeName: 'cocoa' });
  });

  test('concurrent mode and palette changes both survive', async () => {
    await Promise.all([
      setStoredThemeMode('dark'),
      setStoredThemeName('cocoa')
    ]);

    expect(await readWebPreferences()).toEqual({ themeMode: 'dark', themeName: 'cocoa' });
  });

  test('a palette that is not a usable id reads as the built-in one', async () => {
    await fs.writeFile(getPreferencesPath(), JSON.stringify({ themeName: '../escape' }), 'utf-8');
    clearWebPreferencesCache();
    expect(await getStoredThemeName()).toBe(DEFAULT_THEME_NAME);
  });

  test('stores and reads back each mode', async () => {
    for (const mode of THEME_MODES) {
      await setStoredThemeMode(mode);
      expect(await getStoredThemeMode()).toBe(mode);
    }
  });

  test('overlapping saves use independent temporary files', async () => {
    await expect(Promise.all([
      setStoredThemeMode('light'),
      setStoredThemeMode('dark')
    ])).resolves.toEqual(['light', 'dark']);

    expect(['light', 'dark']).toContain(await getStoredThemeMode());
    expect(await fs.readdir(workDir)).toEqual(['web-preferences.json']);
  });

  test('the stored file is the plain JSON it looks like', async () => {
    await setStoredThemeMode('dark');
    const raw = await fs.readFile(getPreferencesPath(), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ themeMode: 'dark' });
  });

  test('refuses a mode it does not know, leaving the stored one alone', async () => {
    await setStoredThemeMode('dark');
    await expect(setStoredThemeMode('chartreuse')).rejects.toThrow('chartreuse');
    expect(await getStoredThemeMode()).toBe('dark');
  });

  test('unrelated keys in the file survive a theme change', async () => {
    await fs.writeFile(getPreferencesPath(),
      JSON.stringify({ themeMode: 'light', somethingElse: 42 }), 'utf-8');
    clearWebPreferencesCache();

    await setStoredThemeMode('dark');

    const stored = JSON.parse(await fs.readFile(getPreferencesPath(), 'utf-8'));
    expect(stored).toEqual({ themeMode: 'dark', somethingElse: 42 });
  });

  test('a corrupt or hand-mangled file reads as the default rather than throwing', async () => {
    for (const contents of ['not json at all', '{"themeMode":', '{"themeMode":"chartreuse"}', '[]']) {
      await fs.writeFile(getPreferencesPath(), contents, 'utf-8');
      clearWebPreferencesCache();
      expect(await getStoredThemeMode()).toBe(DEFAULT_THEME_MODE);
    }
  });

  test('an edit made behind the server is picked up without a restart', async () => {
    await setStoredThemeMode('light');
    expect(await getStoredThemeMode()).toBe('light');

    // Rewritten by hand, with no cache to clear — the mtime has to carry it.
    await new Promise(resolve => setTimeout(resolve, 10));
    await fs.writeFile(getPreferencesPath(), JSON.stringify({ themeMode: 'dark' }), 'utf-8');

    expect(await getStoredThemeMode()).toBe('dark');
  });

  test('isThemeMode accepts exactly the modes the display offers', () => {
    expect(THEME_MODES.every(isThemeMode)).toBe(true);
    for (const mode of ['', null, undefined, 'Dark', 'auto', 42]) {
      expect(isThemeMode(mode)).toBe(false);
    }
  });
});
