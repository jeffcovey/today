/**
 * Today's own files inside the vault.
 *
 * The vault is the user's notes, but a handful of files in it belong to the
 * app: the palettes it offers, the quotes on the calm panel, the links across
 * the top of it. Those gather under one directory — `today/` by default,
 * named by `app_directory` in the config — so the vault root stays the
 * user's own.
 *
 * Nothing has to move for that to be true. Each file is looked for under the
 * app directory first and at the vault root second, the same search order the
 * config path itself uses, so a vault written before the directory existed
 * keeps working and can be tidied whenever its owner feels like it.
 *
 * These files are read on demand and held until their mtime moves, so editing
 * one shows up without a restart. The resolved path is part of the cache key:
 * moving a file into the app directory is a change of path, not of content,
 * and would otherwise go unnoticed.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

/** The default name of the directory inside the vault that holds app files. */
export const APP_DIRNAME = 'today';

/**
 * The places one of Today's own vault files may be, in the order they win:
 * under the app directory, then at the vault root.
 */
export function appPathCandidates(vaultPath, relativePath, appDirectory = APP_DIRNAME) {
  const directory = String(appDirectory || '').replace(/^\/+|\/+$/g, '');
  const atRoot = path.join(vaultPath, relativePath);
  if (!directory) return [atRoot];
  return [path.join(vaultPath, directory, relativePath), atRoot];
}

/**
 * Where to read one of Today's own vault files from: under the app directory
 * if it is there, at the vault root if it is not. For callers that need the
 * path itself rather than the contents; a read uses the candidates directly,
 * since the stat that finds the file is the same stat that dates it.
 */
export function resolveAppPath(vaultPath, relativePath, appDirectory = APP_DIRNAME) {
  const candidates = appPathCandidates(vaultPath, relativePath, appDirectory);
  // Neither being there is a legitimate state for every one of these files.
  // The preferred path goes back rather than the old one, so anything that
  // reports a missing file names where it should go, not where it used to.
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

// ── Reading them ───────────────────────────────────────────────────────────

const caches = new Map();

/** Drop the held copies. For tests, and for anything that moves the vault. */
export function clearVaultAppFileCache() {
  caches.clear();
}

/**
 * The contents, and a stamp that changes when they do. One `stat` per read in
 * the common case — the file is where the app directory says it is, and that
 * stat both finds it and dates it. The parse happens only when the stamp
 * moves, so a page load on an unchanged file costs a stat and nothing else.
 *
 * Where the file was found is part of the stamp as well as its mtime: moving
 * a file into the app directory changes where it is without changing what it
 * says, and a cache keyed on mtime alone would serve the old parse.
 */
async function readAppFile(vaultPath, relativePath, appDirectory, parse) {
  const candidates = appPathCandidates(vaultPath, relativePath, appDirectory);
  for (const [place, file] of candidates.entries()) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }

    // Which candidate won, not its path: the stamp is handed out as an ETag,
    // and a response header is no place for a filesystem path.
    const stamp = `${place}:${stat.mtimeMs}`;
    const held = caches.get(file);
    if (held && held.stamp === stamp) return held;

    const entry = { value: parse(await fs.readFile(file, 'utf-8')), stamp };
    caches.set(file, entry);
    return entry;
  }

  // No file at all, which is normal: the panel shows nothing. The empty stamp
  // is still a stamp, so a caller can answer 304 for "still nothing".
  return { value: [], stamp: '' };
}

// ── The calm panel's quotes ────────────────────────────────────────────────
// One per line as "- Text — Author", because they are the user's own words to
// choose rather than a list shipped with the app.

export const QUOTES_FILENAME = 'quotes.md';
const QUOTE_SEPARATOR = ' — ';

export function parseVaultQuotes(content) {
  const quotes = [];
  for (const line of content.split('\n')) {
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (!item) continue;
    const text = item[1].trim();
    if (!text) continue;
    // Split on the last separator, so a quote may contain a dash of its own.
    const cut = text.lastIndexOf(QUOTE_SEPARATOR);
    quotes.push(cut === -1
      ? { text, author: '' }
      : { text: text.slice(0, cut).trim(), author: text.slice(cut + QUOTE_SEPARATOR.length).trim() });
  }
  return quotes;
}

/** `{ value: quotes, stamp }`. */
export function readVaultQuotes(vaultPath, appDirectory) {
  return readAppFile(vaultPath, QUOTES_FILENAME, appDirectory, parseVaultQuotes);
}

// ── The calm panel's links ─────────────────────────────────────────────────
// An unordered list of ordinary markdown links, shown across the top of the
// panel as "GitHub • OlderGay.Men". A plain markdown list so the file reads
// as a page in the vault, and is editable from a phone like any other note.

export const LINKS_FILENAME = 'links.md';

// `- [Label](target)`, with markdown's optional title after the target.
const LINK_LINE = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)\s*$/;

/**
 * Whether a link in that file is one we are willing to put in an href. The
 * file is the user's own, but it arrives over whatever syncs their vault, and
 * a `javascript:` target in a document that looks like notes is not something
 * the panel should be the one to honour. Anything without a scheme is a path
 * within the vault, which is the common case and carries no scheme risk.
 */
export function isSafeLinkTarget(target) {
  const value = String(target);
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(value)) return false;
  const scheme = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme) return ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase());
  // Protocol-relative: no scheme to check, but it still leaves the site.
  return !value.startsWith('//');
}

export function parseVaultLinks(content) {
  const links = [];
  for (const line of content.split('\n')) {
    const item = line.match(LINK_LINE);
    if (!item) continue;
    const label = item[1].trim();
    const href = item[2].trim();
    if (!label || !href) continue;
    if (!isSafeLinkTarget(href)) continue;
    links.push({ label, href });
  }
  return links;
}

/** `{ value: links, stamp }`. */
export function readVaultLinks(vaultPath, appDirectory) {
  return readAppFile(vaultPath, LINKS_FILENAME, appDirectory, parseVaultLinks);
}
