/**
 * Themes the user keeps in their vault.
 *
 * Every colour in the web view comes from a `--today-*` custom property in
 * `src/web/public/css/style.css`, so a theme is nothing but a set of values
 * for those properties. A file under `vault/themes/` supplies some or all of
 * them, for light and dark separately, and the display menu offers it
 * alongside the built-in palette.
 *
 * The values are hand-written and end up inside a CSS response, so nothing is
 * taken on trust: a value has to parse as a colour this module can convert to
 * RGB, or it is dropped and the token keeps its built-in value.
 */

import fs from 'fs/promises';
import path from 'path';
import { parse as parseToml } from 'smol-toml';

/** The id of the palette that ships with Today; not a file, and never shadowed. */
export const BUILT_IN_THEME_ID = 'today';
export const BUILT_IN_THEME_NAME = 'Today';

/** The directory, relative to the vault root, that themes are read from. */
export const THEMES_DIRNAME = 'themes';

/**
 * The tokens a theme may set, without their `--today-` prefix. This is the
 * vocabulary a theme file is written in, so it is spelled out rather than
 * discovered: a typo in a file should be reported, not silently invented.
 * It mirrors the `:root` block of style.css.
 */
export const THEME_TOKENS = [
  'bg',
  'card-bg',
  'muted-bg',
  'border',
  'control-border',
  'text',
  'muted-text',
  'hover-bg',
  'overlay',
  'surface-2',
  'link',
  'accent',
  'brand-bg',
  'brand-text',
  'header-bg',
  'header-text',
  'button-bg',
  'button-hover-bg',
  'code-text',
  'code-bg',
  'code-block-bg',
  'code-block-text',
  'you-bg',
  'you-border',
  'attn-text',
  'attn-bg',
  'attn-edge',
  'ok-text',
  'ok-bg',
  'ok-edge',
  'info-text',
  'info-bg',
  'info-edge',
  'err-text',
  'err-bg',
  'err-edge',
  // FAMILY: what a thing is about. Deliberately a separate set from the
  // status tokens above, so darkening a status colour for contrast cannot
  // move a family with it. See the comment on these in style.css.
  'family-work',
  'family-day',
  'family-time',
  'family-world',
  'family-self',
  'family-site'
];

const TOKEN_SET = new Set(THEME_TOKENS);

/** Both modes are optional; a theme may restyle only one of them. */
export const THEME_MODE_SECTIONS = ['light', 'dark'];

const MAX_NAME_LENGTH = 60;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * MDB reads a few of its own properties that style.css cannot express as
 * `var(--today-…)`, because MDB composes them as `rgba(var(--…-rgb), a)` and
 * a var() colour cannot feed that. They are derived here instead, from the
 * theme's own values, so a theme that moves the link, brand or text colour
 * moves MDB's with it. The rest of the bridge is plain `var()` in style.css.
 *
 * `brand-bg` is in both modes because MDB ships no dark override for its
 * primary: `.bg-primary` — the AI card header, the badges — is
 * `rgba(var(--mdb-primary-rgb), var(--mdb-bg-opacity))` in either one, so
 * without this line a vault palette would leave them MDB's blue. The navbar
 * is no longer among them; it paints itself from `--today-header-bg`.
 */
const RGB_BRIDGES = {
  light: {
    link: ['--mdb-link-color-rgb'],
    'brand-bg': ['--mdb-primary-rgb']
  },
  dark: {
    link: ['--mdb-link-color-rgb'],
    'brand-bg': ['--mdb-primary-rgb'],
    text: ['--mdb-surface-color-rgb', '--mdb-body-color-rgb']
  }
};

const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL_PATTERN = /^(rgba?|hsla?)\(([^()]*)\)$/i;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function parseHex(value) {
  const digits = value.slice(1);
  const wide = digits.length > 4;
  const step = wide ? 2 : 1;
  const channel = (index) => {
    const part = digits.substr(index * step, step);
    return parseInt(wide ? part : part + part, 16);
  };
  const alpha = digits.length === 4 || digits.length === 8
    ? channel(3) / 255
    : 1;
  return { r: channel(0), g: channel(1), b: channel(2), a: alpha };
}

/** One `rgb()`/`hsl()` argument: a number, optionally a percentage. */
function parseNumericArgument(raw, { percentOf = null } = {}) {
  const text = raw.trim();
  const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(%?)$/.exec(text);
  if (!match) return null;
  const value = parseFloat(text);
  if (!Number.isFinite(value)) return null;
  if (match[1] === '%') {
    return percentOf === null ? value / 100 : (value / 100) * percentOf;
  }
  return value;
}

function hueToChannel(p, q, t) {
  let shifted = t;
  if (shifted < 0) shifted += 1;
  if (shifted > 1) shifted -= 1;
  if (shifted < 1 / 6) return p + (q - p) * 6 * shifted;
  if (shifted < 1 / 2) return q;
  if (shifted < 2 / 3) return p + (q - p) * (2 / 3 - shifted) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const grey = Math.round(l * 255);
    return { r: grey, g: grey, b: grey };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hueToChannel(p, q, hue + 1 / 3) * 255),
    g: Math.round(hueToChannel(p, q, hue) * 255),
    b: Math.round(hueToChannel(p, q, hue - 1 / 3) * 255)
  };
}

/**
 * Parse a colour, or return null. Deliberately narrow: hex and the rgb/hsl
 * functions, nothing else. There are no named colours and no `url()`, so
 * there is no way to smuggle a request or a second declaration through a
 * theme file.
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value || value.length > 64) return null;

  if (HEX_PATTERN.test(value)) return parseHex(value);

  const functional = FUNCTIONAL_PATTERN.exec(value);
  if (!functional) return null;
  const kind = functional[1].toLowerCase();
  // Both the legacy comma form and the modern space form, with the alpha
  // after a slash in the latter.
  const [body, alphaPart] = functional[2].split('/');
  const parts = body.trim().split(/\s*,\s*|\s+/).filter(Boolean);
  const hasInlineAlpha = alphaPart === undefined && parts.length === 4;
  if (parts.length !== 3 && !hasInlineAlpha) return null;

  const alphaSource = alphaPart !== undefined ? alphaPart : (hasInlineAlpha ? parts[3] : null);
  let alpha = 1;
  if (alphaSource !== null) {
    const parsed = parseNumericArgument(alphaSource);
    if (parsed === null) return null;
    alpha = clamp(parsed, 0, 1);
  }

  if (kind === 'rgb' || kind === 'rgba') {
    const channels = parts.slice(0, 3).map((part) => parseNumericArgument(part, { percentOf: 255 }));
    if (channels.some((channel) => channel === null)) return null;
    const [r, g, b] = channels.map((channel) => clamp(Math.round(channel), 0, 255));
    return { r, g, b, a: alpha };
  }

  const hue = parseNumericArgument(parts[0]);
  const saturation = parseNumericArgument(parts[1], { percentOf: 1 });
  const lightness = parseNumericArgument(parts[2], { percentOf: 1 });
  if (hue === null || saturation === null || lightness === null) return null;
  const { r, g, b } = hslToRgb(hue, clamp(saturation, 0, 1), clamp(lightness, 0, 1));
  return { r, g, b, a: alpha };
}

/** Render a parsed colour back out, so only values we understand are emitted. */
function formatColor({ r, g, b, a }) {
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(4))})`;
}

/**
 * Turn one parsed TOML file into a theme, or return null with the reasons.
 * A file is never fatal: an unusable one is left out of the menu.
 */
export function buildTheme(id, parsed) {
  const problems = [];
  if (!ID_PATTERN.test(id) || id.toLowerCase() === BUILT_IN_THEME_ID) {
    return { theme: null, problems: [`"${id}" is not a usable theme id`] };
  }

  const rawName = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
  const name = rawName ? rawName.slice(0, MAX_NAME_LENGTH) : id;

  const modes = {};
  let tokenCount = 0;
  for (const mode of THEME_MODE_SECTIONS) {
    const section = parsed?.[mode];
    if (section === undefined) continue;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      problems.push(`[${mode}] is not a table`);
      continue;
    }
    const tokens = {};
    for (const [key, value] of Object.entries(section)) {
      if (!TOKEN_SET.has(key)) {
        problems.push(`[${mode}] has no token "${key}"`);
        continue;
      }
      const color = parseColor(value);
      if (!color) {
        problems.push(`[${mode}] ${key} is not a colour this can read: ${JSON.stringify(value)}`);
        continue;
      }
      tokens[key] = color;
      tokenCount += 1;
    }
    modes[mode] = tokens;
  }

  if (tokenCount === 0) {
    problems.push('sets no colours');
    return { theme: null, problems };
  }
  return { theme: { id, name, modes }, problems };
}

function declarationsFor(mode, tokens) {
  const lines = [];
  for (const token of THEME_TOKENS) {
    const color = tokens[token];
    if (!color) continue;
    lines.push(`  --today-${token}: ${formatColor(color)};`);
    for (const property of RGB_BRIDGES[mode]?.[token] || []) {
      lines.push(`  ${property}: ${color.r}, ${color.g}, ${color.b};`);
    }
  }
  return lines;
}

/**
 * The stylesheet for a theme. It only ever sets properties, and only ones it
 * has parsed, so the worst a bad file can do is choose an ugly colour.
 */
export function renderThemeCss(theme) {
  if (!theme) return '';
  // Declarations only, and no comment naming the file: this stylesheet is
  // served before login, because the login page wears the palette too, and a
  // vault file name is not something to hand out at the door.
  const blocks = [];
  const selectors = { light: ':root', dark: 'html[data-theme="dark"]' };
  for (const mode of THEME_MODE_SECTIONS) {
    const lines = declarationsFor(mode, theme.modes[mode] || {});
    if (lines.length) blocks.push(`${selectors[mode]} {\n${lines.join('\n')}\n}`);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

// The directory is read on page loads, so the parsed themes are kept and
// re-read only when a file's size or mtime changes. Editing a theme shows up
// on the next load; no restart, and a normal request costs one readdir and a
// stat per file.
let cache = null;

function signatureOf(entries) {
  return entries.map(({ file, stat }) => `${file}:${stat.mtimeMs}:${stat.size}`).join('|');
}

/**
 * Every usable theme in the vault, by id. A missing directory is the normal
 * case, not an error. Returns `{ themes, problems }`, where `problems` maps a
 * file to what is wrong with it so the server can say so.
 */
export async function readVaultThemes(vaultPath) {
  const directory = path.join(vaultPath, THEMES_DIRNAME);

  let files;
  try {
    files = (await fs.readdir(directory))
      .filter((file) => file.toLowerCase().endsWith('.toml'))
      .sort();
  } catch {
    cache = null;
    return { themes: new Map(), problems: new Map() };
  }

  const entries = [];
  for (const file of files) {
    try {
      entries.push({ file, stat: await fs.stat(path.join(directory, file)) });
    } catch {
      // Vanished between the listing and the stat; it simply isn't there.
    }
  }

  const signature = signatureOf(entries);
  if (cache && cache.directory === directory && cache.signature === signature) {
    return cache.value;
  }

  const themes = new Map();
  const problems = new Map();
  for (const { file } of entries) {
    const id = file.slice(0, -'.toml'.length);
    let parsed;
    try {
      parsed = parseToml(await fs.readFile(path.join(directory, file), 'utf-8'));
    } catch (error) {
      problems.set(file, [`is not valid TOML: ${error.message}`]);
      continue;
    }
    const { theme, problems: fileProblems } = buildTheme(id, parsed);
    if (fileProblems.length) problems.set(file, fileProblems);
    if (theme) themes.set(theme.id, theme);
  }

  const value = { themes, problems };
  cache = { directory, signature, value };
  return value;
}

/** Drop the in-memory copy. For tests, and for anything that moves the vault. */
export function clearVaultThemesCache() {
  cache = null;
}

/**
 * The menu's list: the built-in palette first, then the vault's, by name.
 */
export async function listThemes(vaultPath) {
  const { themes } = await readVaultThemes(vaultPath);
  const vaultThemes = [...themes.values()]
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{ id: BUILT_IN_THEME_ID, name: BUILT_IN_THEME_NAME }, ...vaultThemes];
}

/**
 * The stylesheet for the chosen theme, and an ETag over what produced it. A
 * theme that has been deleted or renamed falls back to the built-in palette,
 * which is an empty stylesheet.
 */
export async function getThemeStylesheet(vaultPath, id) {
  const { themes } = await readVaultThemes(vaultPath);
  const theme = (id && id !== BUILT_IN_THEME_ID ? themes.get(id) : null) || null;
  const css = renderThemeCss(theme);
  return { css, theme };
}
