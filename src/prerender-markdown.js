#!/usr/bin/env node

/**
 * Pre-render vault markdown files to the disk HTML cache.
 *
 * Calls the web server's /_cache/warm endpoint, which walks the vault and
 * renders any markdown file whose disk cache is missing or stale (based on
 * the source file's mtime).  Only files without dynamic content (tasks
 * queries, dataview blocks) are persisted to disk; those are rendered
 * on-demand by the server and held in the faster in-memory cache.
 *
 * Usage:
 *   node src/prerender-markdown.js
 *   bin/prerender
 *
 * The server must already be running.  WEB_PORT (default 3000) controls
 * which port is targeted.
 */

const PORT = process.env.WEB_PORT || 3000;
const WARM_URL = `http://127.0.0.1:${PORT}/_cache/warm`;

async function main() {
  console.log(`[prerender] Requesting cache warm from ${WARM_URL} …`);

  let res;
  try {
    res = await fetch(WARM_URL, { method: 'POST' });
  } catch (err) {
    console.error(`[prerender] Could not reach web server at ${WARM_URL}: ${err.message}`);
    console.error('[prerender] Make sure the web server is running before running this script.');
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[prerender] Server returned ${res.status}: ${body}`);
    process.exit(1);
  }

  const data = await res.json().catch(() => ({}));
  console.log(`[prerender] ${data.message ?? 'Cache warm triggered.'}`);
  console.log('[prerender] The server will log progress as it renders files in the background.');
}

main();
