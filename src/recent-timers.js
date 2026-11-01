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

// Only timers started in this many days are considered. The cutoff is on
// start_time because that column is indexed, so the home page reads weeks of
// logs, not years: over 30,000 entries a full scan took about 25 ms per render.
export const RECENT_TIMERS_DAYS = 60;

// Rows read to find them: far more than enough for five distinct ones.
const RECENT_TIMERS_SCAN = 300;

// Two descriptions that differ only in case or spacing are the same activity.
function descriptionKey(description) {
  return description.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The most recent distinct descriptions of finished timers, newest first.
 * A description that recurs is listed once, at its most recent use, spelled
 * as it was then: spacing is ignored for the comparison but kept in what is
 * returned, since that is what a restart starts.
 *
 * @returns {string[]}
 */
export function getRecentTimerDescriptions(db, { limit = RECENT_TIMERS_LIMIT, now = new Date() } = {}) {
  // A calendar date a day wider than the window, so no offset can push an
  // entry inside it out: start_time is compared as text.
  const since = new Date(now.getTime() - (RECENT_TIMERS_DAYS + 1) * 86400000).toISOString().slice(0, 10);
  let rows;
  try {
    rows = db.prepare(`
      SELECT description
      FROM time_logs
      WHERE start_time >= ?
        AND end_time IS NOT NULL
        AND description IS NOT NULL
        AND TRIM(description) != ''
      -- julianday, not the text: entries keep their UTC offset, so across a
      -- DST change the text order and the time order disagree.
      ORDER BY julianday(end_time) DESC
      LIMIT ?
    `).all(since, RECENT_TIMERS_SCAN);
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
    recent.push(description.trim());
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
    const tokens = description.split(/\s+/).filter(Boolean);
    const words = tokens.filter((token) => !token.startsWith('#')).join(' ');
    const tags = tokens.filter((token) => token.startsWith('#')).join(' ');
    const label = words || tokens.join(' ');
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
