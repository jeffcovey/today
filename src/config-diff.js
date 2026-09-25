/**
 * Work out what actually changed between two parsed configs, so a save can
 * edit those lines rather than rewriting the file.
 *
 * Deliberately narrow: only scalar values inside tables. Anything structural
 * — a table added or removed, an array reshaped — returns null from
 * applyScalarChanges so the caller falls back rather than guessing.
 */

import { setTomlValue } from './toml-edit.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function sameValue(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  return a === b;
}

/**
 * Returns `[{ table, key, value }]` for scalar values that differ, or a single
 * `{ structural: true }` marker when the shape changed in a way this cannot
 * express — a table appearing or disappearing, or a value turning into a table.
 */
export function diffScalarChanges(before, after, tablePath = '') {
  const changes = [];
  const beforeKeys = new Set(Object.keys(before || {}));
  const afterKeys = new Set(Object.keys(after || {}));

  for (const key of afterKeys) {
    const nextValue = after[key];
    const prevValue = (before || {})[key];
    const path = tablePath ? `${tablePath}.${key}` : key;

    if (isPlainObject(nextValue)) {
      if (prevValue === undefined) return [{ structural: true }];
      if (!isPlainObject(prevValue)) return [{ structural: true }];
      const nested = diffScalarChanges(prevValue, nextValue, path);
      if (nested.some(c => c.structural)) return [{ structural: true }];
      changes.push(...nested);
      continue;
    }

    if (isPlainObject(prevValue)) return [{ structural: true }];
    if (prevValue === undefined || !sameValue(prevValue, nextValue)) {
      // A new key inside an existing table is fine; a new top-level key is not,
      // since it has no table to be written into.
      if (!tablePath) return [{ structural: true }];
      changes.push({ table: tablePath, key, value: nextValue });
    }
  }

  // Anything removed is structural — this editor only sets values.
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) return [{ structural: true }];
  }

  return changes;
}

/**
 * Apply scalar changes to the original text. Returns the edited text, or null
 * when the change set is structural or a target line could not be located.
 */
export function applyScalarChanges(raw, changes) {
  if (changes.some(change => change.structural)) return null;

  let text = raw;
  for (const { table, key, value } of changes) {
    const next = setTomlValue(text, table, key, value);
    if (next === null) return null;
    text = next;
  }
  return text;
}
