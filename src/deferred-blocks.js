/**
 * Deferred query blocks: like Turbo Frames' lazy frames, a page is first
 * rendered with a placeholder for each slow query block (tasks, dataview,
 * dataviewjs), and the browser then fills each placeholder from
 * GET /_block. The page shell no longer contains query output, so it can be
 * cached by file mtime like any static page.
 *
 * Placeholders reference blocks by id rather than carrying their source, so
 * the endpoint only ever executes code that is already in the vault file.
 */

import crypto from 'crypto';

export const DEFERRED_BLOCK_ENDPOINT = '/_block';

export function deferredBlockId(kind, source) {
  return crypto.createHash('sha1').update(`${kind}\0${source}`).digest('hex').slice(0, 16);
}

/**
 * Remembers each deferred block's source by (page, id) so /_block can execute
 * it. Entries are lost on restart; the endpoint repopulates them by
 * re-rendering the page shell.
 */
export class DeferredBlockRegistry {
  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
    this.entries = new Map();
  }

  register(urlPath, filePath, kind, source) {
    const id = deferredBlockId(kind, source);
    const key = `${urlPath}\0${id}`;
    this.entries.delete(key); // re-insert as most recent
    this.entries.set(key, { urlPath, filePath, kind, source });
    if (this.entries.size > this.maxSize) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return id;
  }

  get(urlPath, id) {
    return this.entries.get(`${urlPath}\0${id}`) || null;
  }
}

// Single line, no markdown-significant characters, so it can be dropped into
// markdown before rendering as well as into rendered HTML.
export function deferredBlockPlaceholder(urlPath, id) {
  const src = `${DEFERRED_BLOCK_ENDPOINT}?path=${encodeURIComponent(urlPath)}&amp;id=${id}`;
  return `<div class="deferred-block" data-deferred-src="${src}"><span class="text-muted small"><i class="fas fa-spinner fa-spin me-1"></i>Loading…</span></div>`;
}
