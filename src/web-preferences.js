/**
 * Display preferences shared by every browser that opens the web view.
 *
 * The web view has one shared login, so there is one person behind it and one
 * set of preferences. They live in .data/web-preferences.json rather than in
 * the vault (which is a git repository, and would gather a commit per theme
 * toggle) or in today.db (which is a cache and may be rebuilt).
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const THEME_MODES = ['light', 'dark', 'system'];
export const DEFAULT_THEME_MODE = 'system';

const DEFAULT_PREFERENCES_PATH = path.join(__dirname, '..', '.data', 'web-preferences.json');

/** TODAY_WEB_PREFERENCES overrides the location, as TODAY_CONFIG does for config.toml. */
export function getPreferencesPath() {
  return process.env.TODAY_WEB_PREFERENCES || DEFAULT_PREFERENCES_PATH;
}

// The file is read on nearly every request, so keep the parsed value and
// re-read only when it changes on disk. Hand edits are picked up without a
// restart, and a normal request costs one stat.
let cached = null;

export function isThemeMode(mode) {
  return THEME_MODES.includes(mode);
}

function normalise(preferences) {
  const themeMode = preferences?.themeMode;
  return { themeMode: isThemeMode(themeMode) ? themeMode : DEFAULT_THEME_MODE };
}

/**
 * Read the stored preferences. A missing, unreadable or malformed file is not
 * an error: the display falls back to its defaults, which is always safe.
 */
export async function readWebPreferences() {
  const preferencesPath = getPreferencesPath();
  let mtimeMs;
  try {
    ({ mtimeMs } = await fs.stat(preferencesPath));
  } catch {
    cached = null;
    return normalise(null);
  }

  if (cached && cached.path === preferencesPath && cached.mtimeMs === mtimeMs) {
    return cached.value;
  }

  try {
    const value = normalise(JSON.parse(await fs.readFile(preferencesPath, 'utf-8')));
    cached = { path: preferencesPath, mtimeMs, value };
    return value;
  } catch {
    cached = null;
    return normalise(null);
  }
}

/** The file as written, so a change can preserve keys this version doesn't know. */
async function readRawPreferences() {
  try {
    const parsed = JSON.parse(await fs.readFile(getPreferencesPath(), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function getStoredThemeMode() {
  return (await readWebPreferences()).themeMode;
}

/**
 * Store the theme mode, replacing the file atomically so a reader never sees a
 * half-written one. Returns the mode that was stored.
 */
export async function setStoredThemeMode(mode) {
  if (!isThemeMode(mode)) {
    throw new Error(`Unknown theme mode: ${mode}`);
  }
  const next = { ...(await readRawPreferences()), themeMode: mode };
  const preferencesPath = getPreferencesPath();

  await fs.mkdir(path.dirname(preferencesPath), { recursive: true });
  const tempPath = `${preferencesPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  await fs.rename(tempPath, preferencesPath);

  cached = null;
  return mode;
}

/** Drop the in-memory copy. For tests, and for anything that moves the file. */
export function clearWebPreferencesCache() {
  cached = null;
}
