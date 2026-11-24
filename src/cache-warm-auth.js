// Who may call the web server's POST /_cache/warm (src/prerender-markdown.js).
//
// The local machine always may. A caller elsewhere, such as the scheduler in
// its own Docker container, may if it sends the warm token: an HMAC of
// SESSION_SECRET, which both sides read from Today's .env, so the secret
// itself is never sent.
import crypto from 'crypto';

export const WARM_TOKEN_HEADER = 'x-today-warm-token';

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The token for SESSION_SECRET, or '' when there's no secret. */
export function warmToken(sessionSecret) {
  if (!sessionSecret) return '';
  return crypto.createHmac('sha256', sessionSecret).update('today:cache-warm').digest('hex');
}

/**
 * True when a warm request may proceed.
 * @param {string} remoteAddress - the raw socket address (not req.ip, which
 *   trusts proxy headers)
 * @param {string|undefined} token - the request's warm-token header
 * @param {string|undefined} sessionSecret
 */
export function warmRequestAllowed(remoteAddress, token, sessionSecret) {
  if (LOCAL_ADDRESSES.has(remoteAddress || '')) return true;
  const expected = warmToken(sessionSecret);
  if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
