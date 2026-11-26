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
 * which port is targeted on this machine.  TODAY_WEB_INTERNAL_URL (e.g.
 * http://vault-web:3001) points at a server elsewhere, such as another
 * Docker container; the request then carries the warm token derived from
 * SESSION_SECRET (src/cache-warm-auth.js).
 */

import { warmToken, WARM_TOKEN_HEADER } from './cache-warm-auth.js';

const PORT = process.env.WEB_PORT || 3000;
const BASE_URL = (process.env.TODAY_WEB_INTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const WARM_URL = `${BASE_URL}/_cache/warm`;

async function main() {
  console.log(`[prerender] Requesting cache warm from ${WARM_URL} …`);

  const headers = {};
  const token = warmToken(process.env.SESSION_SECRET);
  if (token) headers[WARM_TOKEN_HEADER] = token;

  let res;
  try {
    res = await fetch(WARM_URL, { method: 'POST', headers });
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

main().catch(err => {
  console.error('[prerender] Unexpected error:', err.message);
  process.exit(1);
});
