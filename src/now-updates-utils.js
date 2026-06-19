/**
 * Extract the most recent update entry from now.md content.
 * now-updates plugin prepends newest entries and separates entries with ---.
 */
export function extractMostRecentNowEntry(content) {
  const trimmed = content?.trim();
  if (!trimmed) return null;

  const sections = trimmed
    .split('\n\n---\n\n')
    .map(section => section.trim())
    .filter(Boolean);

  if (sections.length === 0) return null;

  const updateSection = sections.find(section => /^##\s+Update:/m.test(section));
  return updateSection || sections[0];
}
