/**
 * Durable ROLE sections in diary files: the format shared by the markdown-diary
 * plugin, which parses them, and the roles plugin, which writes them.
 *
 *   <!-- ROLE:cpa:START -->
 *   ## 🤖 CPA
 *
 *   ### 14:05
 *
 *   **Status:** OK
 *
 *   Categorized 12 transactions.
 *   <!-- ROLE:cpa:END -->
 *
 * Unlike the TODAY: marker namespace (ephemeral, stripped from past days by
 * the markdown-diary plugin), ROLE: blocks are the permanent record: they are
 * never cleaned up, they count as real diary content, and the plugin parses
 * them into the diary table.
 */

export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function roleStartMarker(role) {
  return `<!-- ROLE:${role}:START -->`;
}

export function roleEndMarker(role) {
  return `<!-- ROLE:${role}:END -->`;
}

/**
 * Extract ROLE blocks from a diary body.
 * Returns { blocks: [{ role, content }], remainder } where remainder is the
 * body with all ROLE blocks removed, so section parsers never attribute
 * role content to an adjacent ## section.
 */
export function extractRoleBlocks(body) {
  const blocks = [];
  const blockRe = /<!-- ROLE:([a-z0-9-]+):START -->\n?([\s\S]*?)<!-- ROLE:\1:END -->\n?/g;

  const remainder = body.replace(blockRe, (match, role, content) => {
    blocks.push({ role, content: stripRoleHeading(content).trim() });
    return '';
  });

  return { blocks, remainder };
}

/** Drop the block's display heading (e.g. "## 🤖 CPA") so it isn't parsed as entry text. */
function stripRoleHeading(content) {
  return content.replace(/^\s*## [^\n]*\n/, '');
}
