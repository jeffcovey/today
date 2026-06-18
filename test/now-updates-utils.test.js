import { extractMostRecentNowEntry } from '../src/now-updates-utils.js';

describe('extractMostRecentNowEntry', () => {
  test('returns null for empty content', () => {
    expect(extractMostRecentNowEntry('')).toBeNull();
    expect(extractMostRecentNowEntry('   ')).toBeNull();
  });

  test('returns newest update when separated by dividers', () => {
    const content = `## Update: 2026-06-18 12:00

Latest update

---

## Update: 2026-06-18 10:00

Older update`;

    expect(extractMostRecentNowEntry(content)).toContain('Latest update');
    expect(extractMostRecentNowEntry(content)).not.toContain('Older update');
  });

  test('prefers an update section if file has a preamble', () => {
    const content = `# Now

Manual intro text.

---

## Update: 2026-06-18 12:00

Latest update`;

    expect(extractMostRecentNowEntry(content)).toMatch(/^## Update:/);
  });
});
