const ROLE_BLOCK_RE = /<!-- ROLE:([a-z0-9-]+):START -->\r?\n([\s\S]*?)<!-- ROLE:\1:END -->/g;

export function extractRoleSections(body) {
  const sections = [];
  for (const match of body.matchAll(ROLE_BLOCK_RE)) {
    const heading = match[2].match(/^## 🤖\s+(.+)$/m);
    if (!heading) continue;
    const headingEnd = match[2].indexOf(heading[0]) + heading[0].length;
    const contentStart = headingEnd + (match[2][headingEnd] === '\r' ? 2 : match[2][headingEnd] === '\n' ? 1 : 0);
    sections.push({ title: heading[1].trim(), content: match[2].slice(contentStart).trim() });
  }
  return sections;
}

export function removeRoleBlocks(body) {
  return body.replace(ROLE_BLOCK_RE, '');
}
