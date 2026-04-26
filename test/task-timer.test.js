/**
 * Task Timer Logic Tests
 *
 * Tests the deduplication, seenIds-skip, and validity-check logic that prevents
 * tasks from appearing multiple times or after they have been completed.
 */

// ── Inline replicas of the patched logic (kept in sync with web-server.js) ──

/**
 * Deduplicates items by id, then shuffles.
 * Mirrors the end of getTodayTaskTimerItems().
 */
function deduplicateAndShuffle(items) {
  const seenItemIds = new Set();
  const dedupedItems = items.filter(item => {
    if (seenItemIds.has(item.id)) return false;
    seenItemIds.add(item.id);
    return true;
  });
  // Use a deterministic "shuffle" for tests (identity – order preserved)
  return dedupedItems;
}

/**
 * Advance index past items that are already seen or no longer valid.
 * Mirrors the while loop in advanceTimerIfNeeded() and the skip endpoint.
 *
 * @param {Array}    items        - Full item list
 * @param {number}   currentIndex - Index to start advancing from (exclusive; we increment first)
 * @param {Set}      seenIds      - IDs already shown this session
 * @param {Function} isValid      - Predicate; returns false for items to skip
 */
function advancePastSeen(items, currentIndex, seenIds, isValid = () => true) {
  let idx = currentIndex;
  idx++;
  while (idx < items.length && (seenIds.has(items[idx].id) || !isValid(items[idx]))) {
    idx++;
  }
  return idx;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getTodayTaskTimerItems – deduplication', () => {
  test('returns unique items when there are no duplicates', () => {
    const items = [
      { id: 'task-a', title: 'Task A' },
      { id: 'habit-uuid1', title: 'Habit 1' },
      { id: 'project-p1', title: 'Project 1' },
    ];
    expect(deduplicateAndShuffle(items)).toHaveLength(3);
  });

  test('removes duplicate habit items with the same habit_id', () => {
    // Two different DB rows for the same habit (different sources) produce the same id
    const items = [
      { id: 'habit-uuid1', title: 'Morning Run' },
      { id: 'task-a', title: 'Task A' },
      { id: 'habit-uuid1', title: 'Morning Run' }, // duplicate from second source
    ];
    const result = deduplicateAndShuffle(items);
    expect(result).toHaveLength(2);
    expect(result.filter(i => i.id === 'habit-uuid1')).toHaveLength(1);
  });

  test('keeps the FIRST occurrence when deduplicating', () => {
    const items = [
      { id: 'habit-uuid1', title: 'First occurrence' },
      { id: 'habit-uuid1', title: 'Second occurrence' },
    ];
    const result = deduplicateAndShuffle(items);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('First occurrence');
  });

  test('handles multiple duplicate IDs across the list', () => {
    const items = [
      { id: 'habit-a', title: 'Habit A' },
      { id: 'habit-b', title: 'Habit B (1st)' },
      { id: 'habit-a', title: 'Habit A dup' },
      { id: 'task-x', title: 'Task X' },
      { id: 'habit-b', title: 'Habit B (2nd)' },
    ];
    const result = deduplicateAndShuffle(items);
    expect(result).toHaveLength(3);
    const ids = result.map(i => i.id);
    expect(ids).toContain('habit-a');
    expect(ids).toContain('habit-b');
    expect(ids).toContain('task-x');
  });

  test('returns empty array for empty input', () => {
    expect(deduplicateAndShuffle([])).toHaveLength(0);
  });
});

describe('timer advancement – skip already-seen items', () => {
  test('advances by one when the next item is not in seenIds', () => {
    const items = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const seenIds = new Set(['a']);
    // Currently at index 0 (a); advance should land on index 1 (b)
    expect(advancePastSeen(items, 0, seenIds)).toBe(1);
  });

  test('skips over items already in seenIds', () => {
    const items = [
      { id: 'a' },
      { id: 'b' }, // already seen
      { id: 'c' },
    ];
    const seenIds = new Set(['a', 'b']);
    // Currently at index 0 (a); b is seen, so should skip to index 2 (c)
    expect(advancePastSeen(items, 0, seenIds)).toBe(2);
  });

  test('returns index equal to items.length when all remaining items are seen', () => {
    const items = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const seenIds = new Set(['a', 'b', 'c']);
    // All items seen – index should go past end
    expect(advancePastSeen(items, 0, seenIds)).toBe(3);
  });

  test('handles single-element list where that element is already seen', () => {
    const items = [{ id: 'a' }];
    const seenIds = new Set(['a']);
    expect(advancePastSeen(items, 0, seenIds)).toBe(1); // past the end
  });
});

describe('timer advancement – skip invalid (completed/reviewed) items', () => {
  // isValid returns false for items whose IDs are in the "completed" set
  const makeIsValid = (completedIds) => (item) => !completedIds.has(item.id);

  test('advances normally when the next item is still valid', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const seenIds = new Set(['a']);
    const isValid = makeIsValid(new Set()); // nothing completed
    expect(advancePastSeen(items, 0, seenIds, isValid)).toBe(1);
  });

  test('skips an item that has been completed externally', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const seenIds = new Set(['a']);
    const isValid = makeIsValid(new Set(['b'])); // b was completed
    // b is invalid, so advancement should land on c (index 2)
    expect(advancePastSeen(items, 0, seenIds, isValid)).toBe(2);
  });

  test('skips multiple consecutive invalid items', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const seenIds = new Set(['a']);
    const isValid = makeIsValid(new Set(['b', 'c'])); // b and c completed
    expect(advancePastSeen(items, 0, seenIds, isValid)).toBe(3); // lands on d
  });

  test('skips a mix of seen-ids and invalid items', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const seenIds = new Set(['a', 'b']); // b already seen
    const isValid = makeIsValid(new Set(['c'])); // c completed externally
    // b skipped (seen), c skipped (invalid), lands on d
    expect(advancePastSeen(items, 0, seenIds, isValid)).toBe(3);
  });

  test('returns items.length when all remaining items are invalid', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const seenIds = new Set(['a']);
    const isValid = makeIsValid(new Set(['b', 'c']));
    expect(advancePastSeen(items, 0, seenIds, isValid)).toBe(3);
  });

  test('does not skip items when isValid always returns true (unknown-type fallback)', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const seenIds = new Set(['a']);
    // isValid always returns true (mirrors "return true" for unknown types in isItemStillValid)
    expect(advancePastSeen(items, 0, seenIds, () => true)).toBe(1);
  });
});

