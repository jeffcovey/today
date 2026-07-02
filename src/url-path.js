/**
 * Normalize wildcard route paths to URL-style, vault-relative paths.
 */
export function normalizeUrlPath(rawPath) {
  const pathText = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath || '');
  return pathText
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
}
