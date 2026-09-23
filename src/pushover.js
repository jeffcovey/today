// Pushover notifications.
//
// Reaches a locked or backgrounded device, which nothing running inside a
// Safari tab can do: iPadOS freezes a background tab's timers outright.
//
// Credentials live in .env, never in the config file. The config file only
// carries the harmless parts, so it stays safe to read and to sync.

import { getConfig } from './config.js';

const PUSHOVER_ENDPOINT = 'https://api.pushover.net/1/messages.json';

export function getPushoverSettings(env = process.env) {
  const settings = getConfig('notifications.pushover') || {};
  return {
    enabled: settings.enabled !== false,
    sound: settings.sound || null,
    priority: typeof settings.priority === 'number' ? settings.priority : null,
    userKey: env.TODAY_PUSHOVER_USER_KEY || '',
    apiToken: env.TODAY_PUSHOVER_API_TOKEN || ''
  };
}

// Why a send is being skipped, or null when it should go ahead. Separated out
// so the decision can be tested without reaching the network.
export function pushoverSkipReason(settings) {
  if (!settings.enabled) return 'disabled in config';
  if (!settings.userKey) return 'TODAY_PUSHOVER_USER_KEY is not set';
  if (!settings.apiToken) return 'TODAY_PUSHOVER_API_TOKEN is not set';
  return null;
}

export function buildPushoverBody({ title, message, settings }) {
  const body = new URLSearchParams({
    token: settings.apiToken,
    user: settings.userKey,
    message
  });
  if (title) body.set('title', title);
  if (settings.sound) body.set('sound', settings.sound);
  if (settings.priority !== null) body.set('priority', String(settings.priority));
  return body;
}

// Never throws and never blocks the caller's own work: a notification that
// cannot be delivered must not stall a task timer phase change.
export async function sendPushover({ title, message }, options = {}) {
  const {
    settings = getPushoverSettings(),
    fetchImpl = fetch,
    timeoutMs = 5000
  } = options;

  const skip = pushoverSkipReason(settings);
  if (skip) return { sent: false, reason: skip };
  if (!message) return { sent: false, reason: 'no message' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(PUSHOVER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildPushoverBody({ title, message, settings }).toString(),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { sent: false, reason: `pushover returned ${response.status}`, detail: detail.slice(0, 300) };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error.name === 'AbortError' ? 'timed out' : error.message };
  } finally {
    clearTimeout(timer);
  }
}
