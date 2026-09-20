/**
 * Detection of rendered pages whose content changes independently of the
 * source file's mtime (task queries, dataview/dataviewjs blocks). Such pages
 * get a short in-memory TTL and are excluded from the persistent disk cache.
 */

// Appended to the output of every executed dataview/dataviewjs block. Block
// output can't be recognised by its CSS classes alone: a dataviewjs view may
// emit arbitrary HTML (eg. time-tracking-widget.js with no entries renders
// just a form and a <p>).
export const DYNAMIC_CONTENT_MARKER = '<!-- today:dynamic-content -->';

export function markDynamic(html) {
  return `${html}${DYNAMIC_CONTENT_MARKER}`;
}

export function containsDynamicContent(html) {
  return html.includes(DYNAMIC_CONTENT_MARKER) ||
    html.includes('tasks-query-result') ||
    html.includes('dataview-table') ||
    html.includes('dataview-list');
}
