/**
 * Unit tests for plugins/vault-snapshot/read.js
 *
 * Tests the keep-N pruning math via the exported `computePruneList` function.
 * This function is pure (no fs I/O) so no temp directories are needed.
 */

import { computePruneList } from '../plugins/vault-snapshot/read.js';

// Generate a list of N fake snapshot names in ascending order.
function makeSnapshots(n) {
  return Array.from({ length: n }, (_, i) =>
    `2024-01-${String(i + 1).padStart(2, '0')}T00-00-00`
  );
}

describe('computePruneList', () => {
  test('returns empty list when snapshots are below the keep limit', () => {
    const snapshots = makeSnapshots(5);
    expect(computePruneList(snapshots, 30)).toEqual([]);
  });

  test('returns empty list when snapshots equal keep - 1', () => {
    const snapshots = makeSnapshots(29);
    expect(computePruneList(snapshots, 30)).toEqual([]);
  });

  test('returns exactly 1 oldest snapshot when existing count equals keep (30 snapshots → keep 30)', () => {
    const snapshots = makeSnapshots(30);
    const toRemove = computePruneList(snapshots, 30);
    expect(toRemove).toHaveLength(1);
    expect(toRemove[0]).toBe(snapshots[0]); // oldest first
  });

  test('removes correct count when well over the keep limit', () => {
    const snapshots = makeSnapshots(40);
    const toRemove = computePruneList(snapshots, 30);
    // 40 existing + 1 new = 41; must trim down to 30; remove 11 oldest
    expect(toRemove).toHaveLength(11);
    expect(toRemove).toEqual(snapshots.slice(0, 11));
  });

  test('returns empty list when there are no existing snapshots (first ever snapshot)', () => {
    expect(computePruneList([], 30)).toEqual([]);
  });

  test('handles keep=1 correctly — always removes all but the newest', () => {
    const snapshots = makeSnapshots(3);
    const toRemove = computePruneList(snapshots, 1);
    // 3 existing + 1 new = 4; trim to 1; remove 3 oldest
    expect(toRemove).toHaveLength(3);
    expect(toRemove).toEqual(snapshots);
  });

  test('removes oldest snapshots, preserving the most recent ones', () => {
    const snapshots = makeSnapshots(35);
    const toRemove = computePruneList(snapshots, 30);
    // 35 existing + 1 new = 36; trim to 30; remove 6 oldest
    expect(toRemove).toHaveLength(6);
    expect(toRemove).toEqual(snapshots.slice(0, 6));
    // The newest snapshots (indices 6–34) should NOT be in the removal list
    const removedSet = new Set(toRemove);
    for (const snap of snapshots.slice(6)) {
      expect(removedSet.has(snap)).toBe(false);
    }
  });
});
