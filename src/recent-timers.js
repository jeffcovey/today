/**
 * Recent focus timers, offered under "What are you working on?" so one can be
 * started again with a tap instead of retyped.
 *
 * Kept apart from web-server.js so the query and the markup can be tested
 * against a plain SQLite database.
 */

// How many to offer. Enough to cover the usual handful of things a day
// alternates between, few enough that the open card stays short on a phone.
export const RECENT_TIMERS_LIMIT = 5;

// Rows read to find them. Bounded so the home page never scans years of
// logs; a few hundred entries is weeks of tracking, far more than enough to
// find five distinct descriptions.
const RECENT_TIMERS_SCAN = 300;

// Two descriptions that differ only in case or spacing are the same activity.
function descriptionKey(description) {
  return description.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The most recent distinct descriptions of finished timers, newest first.
 * A description that recurs is listed once, at its most recent use.
 *
 * @returns {string[]}
 */
export function getRecentTimerDescriptions(db, { limit = RECENT_TIMERS_LIMIT } = {}) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT description
      FROM time_logs
      WHERE end_time IS NOT NULL
        AND description IS NOT NULL
        AND TRIM(description) != ''
      ORDER BY end_time DESC
      LIMIT ?
    `).all(RECENT_TIMERS_SCAN);
  } catch {
    // No time_logs table (time tracking never set up): nothing to offer.
    return [];
  }

  const seen = new Set();
  const recent = [];
  for (const { description } of rows) {
    const key = descriptionKey(description);
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(description.replace(/\s+/g, ' ').trim());
    if (recent.length >= limit) break;
  }
  return recent;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The list under the timer field: one button per recent description, which
 * starts a timer with exactly that description, tags included. The tags are
 * shown smaller, after the words, so the words are what you scan.
 *
 * @param {string[]} descriptions
 * @returns {string} HTML, or '' when there is nothing to offer
 */
export function renderRecentTimers(descriptions) {
  if (!descriptions || descriptions.length === 0) return '';

  const items = descriptions.map((description) => {
    const words = description.split(' ').filter((token) => !token.startsWith('#')).join(' ');
    const tags = description.split(' ').filter((token) => token.startsWith('#')).join(' ');
    const label = words || description;
    const safe = escapeHtml(description);
    return `
            <li>
              <button type="button" class="timer-recent" data-timer-action="start" data-description="${safe}"
                aria-label="Restart: ${safe}" onclick="restartRecentTimer(this)">
                <i class="fas fa-rotate-right" aria-hidden="true"></i>
                <span class="timer-recent-label">${escapeHtml(label)}</span>${words && tags ? `
                <span class="timer-recent-tags">${escapeHtml(tags)}</span>` : ''}
              </button>
            </li>`;
  }).join('');

  return `
          <div class="timer-recents">
            <div class="timer-recents-heading" id="timerRecentsHeading">Recent</div>
            <ul class="timer-recents-list" aria-labelledby="timerRecentsHeading">${items}
            </ul>
          </div>`;
}
