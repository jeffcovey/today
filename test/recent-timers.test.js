/**
 * Recent timers under "What are you working on?": which descriptions are
 * offered, in what order, and the buttons that restart them.
 */

import fs from 'fs';
import Database from 'better-sqlite3';
import {
  getRecentTimerDescriptions,
  renderRecentTimers,
  RECENT_TIMERS_LIMIT,
} from '../src/recent-timers.js';

function timeLogDb(entries) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE time_logs (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, start_time DATETIME NOT NULL,
    end_time DATETIME, duration_minutes INTEGER, description TEXT
  )`);
  const insert = db.prepare('INSERT INTO time_logs VALUES (?, ?, ?, ?, ?, ?)');
  entries.forEach(([start, end, description], i) => {
    insert.run(`log-${i}`, 'markdown-time-tracking/local', start, end, null, description);
  });
  return db;
}

describe('getRecentTimerDescriptions', () => {
  test('newest first, each description once at its latest use', () => {
    const db = timeLogDb([
      ['2026-10-31T12:39:18-04:00', '2026-10-31T13:00:06-04:00', 'Morning routine #topic/personal'],
      ['2026-10-31T13:00:07-04:00', '2026-10-31T13:16:43-04:00', 'Hosting #topic/hosting'],
      ['2026-10-31T14:15:16-04:00', '2026-10-31T15:22:42-04:00', 'OGM site development #topic/ogm_site_development'],
      ['2026-10-31T16:26:49-04:00', '2026-10-31T16:30:53-04:00', 'Hosting #topic/hosting'],
      ['2026-10-31T18:56:49-04:00', '2026-10-31T19:30:14-04:00', 'Zazen'],
    ]);
    expect(getRecentTimerDescriptions(db)).toEqual([
      'Zazen',
      'Hosting #topic/hosting',
      'OGM site development #topic/ogm_site_development',
      'Morning routine #topic/personal',
    ]);
  });

  test(`offers at most ${RECENT_TIMERS_LIMIT}`, () => {
    const entries = Array.from({ length: 12 }, (_, i) => {
      const hour = String(10 + i).padStart(2, '0');
      return [`2026-10-30T${hour}:00:00-04:00`, `2026-10-30T${hour}:30:00-04:00`, `Thing ${i}`];
    });
    const recent = getRecentTimerDescriptions(timeLogDb(entries));
    expect(recent).toHaveLength(RECENT_TIMERS_LIMIT);
    expect(recent[0]).toBe('Thing 11');
    expect(getRecentTimerDescriptions(timeLogDb(entries), { limit: 2 })).toEqual(['Thing 11', 'Thing 10']);
  });

  test('leaves out a running timer and blank descriptions', () => {
    const db = timeLogDb([
      ['2026-10-31T09:00:00-04:00', '2026-10-31T09:30:00-04:00', 'Email'],
      ['2026-10-31T10:00:00-04:00', '2026-10-31T10:05:00-04:00', '   '],
      ['2026-10-31T11:00:00-04:00', null, 'Still running'],
    ]);
    expect(getRecentTimerDescriptions(db)).toEqual(['Email']);
  });

  test('treats differences of case and spacing as the same activity', () => {
    const db = timeLogDb([
      ['2026-10-31T09:00:00-04:00', '2026-10-31T09:30:00-04:00', 'tidy  the house'],
      ['2026-10-31T10:00:00-04:00', '2026-10-31T10:30:00-04:00', 'Tidy the house '],
    ]);
    expect(getRecentTimerDescriptions(db)).toEqual(['Tidy the house']);
  });

  test('is empty when time tracking was never set up', () => {
    expect(getRecentTimerDescriptions(new Database(':memory:'))).toEqual([]);
  });
});

describe('renderRecentTimers', () => {
  test('nothing at all when there is nothing recent', () => {
    expect(renderRecentTimers([])).toBe('');
    expect(renderRecentTimers(undefined)).toBe('');
  });

  test('one restart button per description, carrying it whole', () => {
    const html = renderRecentTimers(['Hosting #topic/hosting', 'Zazen']);
    expect(html.match(/<button /g)).toHaveLength(2);
    expect(html).toContain('data-description="Hosting #topic/hosting"');
    expect(html).toContain('aria-label="Restart: Hosting #topic/hosting"');
    expect(html).toContain('<span class="timer-recent-label">Hosting</span>');
    expect(html).toContain('<span class="timer-recent-tags">#topic/hosting</span>');
    // No tags, no empty tag span.
    expect(html).toContain('<span class="timer-recent-label">Zazen</span>');
    expect(html.match(/timer-recent-tags/g)).toHaveLength(1);
  });

  test('a description that is only tags still has a label', () => {
    expect(renderRecentTimers(['#topic/admin'])).toContain('<span class="timer-recent-label">#topic/admin</span>');
  });

  test('escapes what the log holds', () => {
    const html = renderRecentTimers(['Fix <b>"quotes"</b> & \'apostrophes\'']);
    expect(html).not.toContain('<b>');
    expect(html).toContain('data-description="Fix &lt;b&gt;&quot;quotes&quot;&lt;/b&gt; &amp; &#39;apostrophes&#39;"');
  });

  test('each button starts a clock, so pressing it collapses the card', () => {
    // initializeTimerCards closes the card for controls marked start.
    expect(renderRecentTimers(['Zazen'])).toContain('data-timer-action="start"');
  });
});

describe('wiring', () => {
  const webServerSource = fs.readFileSync(new URL('../src/web-server.js', import.meta.url), 'utf8');
  const commonSource = fs.readFileSync(new URL('../src/web/public/js/common.js', import.meta.url), 'utf8');

  test('the idle focus card shows the list under the field', () => {
    const start = webServerSource.indexOf('function getTimerWidget(');
    const body = webServerSource.slice(start, webServerSource.indexOf('\n}\n', start));
    const field = body.indexOf('id="timerDescription"');
    const list = body.indexOf('renderRecentTimers(recentTimers)');
    expect(field).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(field);
  });

  test('every page that shows the focus card passes recent timers to it', () => {
    const calls = webServerSource.match(/getTimerWidget\([^)]*\)/g).filter(c => !c.startsWith('getTimerWidget(timer, recentTimers'));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/getRecentTimersFor\(/);
  });

  test('the browser posts the description to the track API', () => {
    const handler = commonSource.slice(commonSource.indexOf('function restartRecentTimer('));
    expect(handler).toContain("fetch('/api/track/start'");
    expect(handler).toContain('JSON.stringify({ description })');
  });
});
