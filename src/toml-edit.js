/**
 * Minimal surgical TOML editing.
 *
 * `stringify` round-trips a config through a plain object, which cannot carry
 * comments, section order or formatting. Saving then destroys all of them,
 * whether or not the user touched that part of the file — that is how a
 * warning comment about a known failure was deleted, and how a plugin the
 * user had configured was written back as `enabled = false`.
 *
 * These helpers change only the lines that need changing and leave every
 * other byte alone.
 */

import { stringify as stringifyToml } from 'smol-toml';

// The header line of a table, e.g. `[plugins.imap-email.icloud]`. Array-of-table
// headers (`[[x]]`) are deliberately not matched: this editor does not handle
// them, and callers fall back rather than guess.
const TABLE_HEADER = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/;

function isArrayOfTablesHeader(line) {
  return /^\s*\[\[/.test(line);
}

function findBasicStringEnd(line, start) {
  for (let i = start; i < line.length; i++) {
    if (line[i] !== '"') continue;

    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

function findMultilineBasicEnd(line, start) {
  for (let i = start; i <= line.length - 3; i++) {
    if (line[i] !== '"') continue;

    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 !== 0) continue;

    let runEnd = i;
    while (runEnd < line.length && line[runEnd] === '"') runEnd++;
    if (runEnd - i >= 3) return runEnd - 3;
    i = runEnd - 1;
  }
  return -1;
}

function updateMultilineState(line, multiline) {
  if (multiline) {
    const end = multiline === '"""'
      ? findMultilineBasicEnd(line, 0)
      : line.indexOf(multiline);
    return end === -1 ? multiline : null;
  }

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '#') break;

    if (char === "'") {
      if (line.slice(i, i + 3) === "'''") {
        const end = line.indexOf("'''", i + 3);
        if (end === -1) return "'''";
        i = end + 2;
      } else {
        const end = line.indexOf("'", i + 1);
        if (end === -1) break;
        i = end;
      }
      continue;
    }

    if (char !== '"') continue;

    if (line.slice(i, i + 3) === '"""') {
      const end = findMultilineBasicEnd(line, i + 3);
      if (end === -1) return '"""';
      i = end + 2;
      continue;
    }

    const end = findBasicStringEnd(line, i + 1);
    if (end === -1) break;
    i = end;
  }

  return null;
}

function firstTableHeaderIndex(lines) {
  let multiline = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!multiline) {
      const match = line.match(TABLE_HEADER);
      if (match && !isArrayOfTablesHeader(line)) return index;
    }
    multiline = updateMultilineState(line, multiline);
  }

  return lines.length;
}

// Where each table starts and ends, by dotted path. End is exclusive and stops
// before the blank lines and comments that introduce the next table, so an
// insertion lands inside the table it belongs to.
export function findTableRanges(lines) {
  const ranges = new Map();
  let current = null;
  let multiline = null;

  lines.forEach((line, index) => {
    if (multiline) {
      multiline = updateMultilineState(line, multiline);
      return;
    }

    const match = line.match(TABLE_HEADER);
    if (match && !isArrayOfTablesHeader(line)) {
      if (current) ranges.get(current).end = lastMeaningfulLine(lines, index);
      current = match[1].trim();
      ranges.set(current, { header: index, start: index + 1, end: lines.length });
    }

    multiline = updateMultilineState(line, multiline);
  });

  if (current) ranges.get(current).end = lastMeaningfulLine(lines, lines.length);
  return ranges;
}

// Walk back over blank lines and the comment block attached to the next table,
// so a value appended to a table is not pushed past its own contents.
function lastMeaningfulLine(lines, beforeIndex) {
  let end = beforeIndex;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return end;
}

// Matches `key = ...` at the start of a line, ignoring indentation.
function keyLineIndex(lines, range, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let multiline = null;

  for (let i = range.start; i < range.end; i++) {
    if (!multiline && pattern.test(lines[i])) return i;
    multiline = updateMultilineState(lines[i], multiline);
  }
  return -1;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Render a single value the way smol-toml would, by serialising a throwaway
// table and taking what follows the `=`. Keeps quoting and escaping consistent
// with the rest of the file rather than reinventing it.
export function formatTomlValue(value) {
  const rendered = stringifyToml({ v: value }).trim();
  return rendered.slice(rendered.indexOf('=') + 1).trim();
}

/**
 * Set `key` inside table `tablePath`, creating neither if absent — callers
 * that need creation should handle it, so a failure here is visible rather
 * than silently inventing structure.
 *
 * Returns the edited text, or null when the table or key could not be found.
 */
export function setTomlValue(raw, tablePath, key, value) {
  const lines = raw.split('\n');
  const range = tablePath
    ? findTableRanges(lines).get(tablePath)
    : { start: 0, end: firstTableHeaderIndex(lines) };
  if (!range) return null;

  const formatted = formatTomlValue(value);
  const index = keyLineIndex(lines, range, key);

  if (index === -1) {
    lines.splice(range.end, 0, `${key} = ${formatted}`);
  } else {
    // Preserve any trailing comment on the line being changed.
    const trailing = lines[index].match(/\s(#.*)$/);
    lines[index] = `${key} = ${formatted}${trailing ? ' ' + trailing[1] : ''}`;
  }

  return lines.join('\n');
}

/**
 * Remove table `tablePath` and the comment block directly above it.
 * Returns the edited text, or null when the table is absent.
 */
export function removeTomlTable(raw, tablePath) {
  const lines = raw.split('\n');
  const ranges = findTableRanges(lines);
  const range = ranges.get(tablePath);
  if (!range) return null;

  // Take the contiguous comment lines immediately above the header with it;
  // they describe the table being removed.
  let from = range.header;
  while (from > 0 && lines[from - 1].trim().startsWith('#')) from--;

  let to = range.end;
  while (to < lines.length && lines[to].trim() === '') to++;

  lines.splice(from, to - from);
  return lines.join('\n');
}
