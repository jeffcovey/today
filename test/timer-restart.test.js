import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { startServer, PASSWORD } from './helpers/a11y-harness.js';

/**
 * The Task Timer and the Pomodoro survive a web-server restart (#655).
 *
 * These are real restarts: a server is started against an isolated vault and
 * its own .data, a timer is started through the API, the process is killed,
 * and a second server is started over the same directory. Nothing is stubbed,
 * so what passes here is what `bin/today web restart` does.
 *
 * Downtime is simulated by winding every timestamp in the saved file back by
 * a fixed amount between the two servers, which is indistinguishable, to the
 * server that comes up, from having been down that long -- and lets the
 * assertions name an exact remaining time instead of waiting out a real
 * 25-minute work period.
 */

jest.setTimeout(240_000);

const MINUTE = 60_000;
const WORK_MINUTES = 25;          // the harness's fixture config
const REST_SECONDS = Math.round(WORK_MINUTES * 60 * 0.1);

let workDir = null;

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

const statePath = () => path.join(workDir, 'timer-state.json');

async function api(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PASSWORD}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${route} -> ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function home(baseUrl) {
  const response = await fetch(`${baseUrl}/`, { headers: { Authorization: `Bearer ${PASSWORD}` } });
  if (!response.ok) throw new Error(`GET / -> ${response.status}`);
  return response.text();
}

/** Start a server over the shared work directory, run `fn`, then kill it. */
async function withServer(fn) {
  const server = await startServer({ workDir, keepWorkDir: true });
  workDir = server.workDir;
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

/** Wind every saved timestamp back, so the next server sees `ms` of downtime. */
function simulateDowntime(ms) {
  const file = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
  const shift = (holder, key) => {
    if (holder && typeof holder[key] === 'string') {
      holder[key] = new Date(Date.parse(holder[key]) - ms).toISOString();
    }
  };
  shift(file, 'savedAt');
  shift(file.taskTimer, 'startTime');
  shift(file.taskTimer, 'pausedAt');
  shift(file.pomodoro, 'startTime');
  shift(file.pomodoro, 'pausedAt');
  fs.writeFileSync(statePath(), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Run `setup` on one server, kill it, wind the clock back by `downtimeMs`,
 * then bring a second server up over the same directory and return its home
 * page. The shape of every test here.
 */
async function restartAfter(downtimeMs, setup) {
  if (workDir) fs.rmSync(statePath(), { force: true });
  const before = await withServer(async (server) => {
    await setup(server);
    return home(server.baseUrl);
  });
  expect(fs.existsSync(statePath())).toBe(true);   // written on the transition
  if (downtimeMs > 0) simulateDowntime(downtimeMs);
  const after = await withServer((server) => home(server.baseUrl));
  return { before, after };
}

const startTaskTimer = (server) => api(server.baseUrl, '/api/task-timer/start', { duration: WORK_MINUTES });
const startPomodoro = (server) => api(server.baseUrl, '/api/pomodoro/start');

async function startBoth(server) {
  await startTaskTimer(server);
  await startPomodoro(server);
}

const attribute = (html, name) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

// The time tracker's own banner carries data-timer-start too, and it is the
// first on the page, so the Task Timer's is read off the pair of attributes
// only it has.
const taskTimerStart = (html) =>
  html.match(/data-timer-start="([^"]*)" data-timer-total-seconds/)?.[1] ?? null;
const taskTimerRunning = (html) => html.includes('data-timer-total-seconds=');
const pomodoroRunning = (html) => html.includes('data-pomodoro-start=');

/** The countdown the server rendered, in seconds. */
function countdown(html, className) {
  const match = html.match(new RegExp(`<span class="${className}">(\\d+):(\\d\\d)</span>`));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

const taskCountdown = (html) => countdown(html, 'task-timer-countdown');
const pomodoroCountdown = (html) => countdown(html, 'pomodoro-countdown');

/** A rendered countdown is a second or two behind by the time it is asserted. */
function expectAboutSeconds(actual, expected) {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(10);
}

describe('restarting with both timers running', () => {
  test('brings them back where they were', async () => {
    const { before, after } = await restartAfter(0, startBoth);

    expectAboutSeconds(taskCountdown(before), WORK_MINUTES * 60);
    expectAboutSeconds(pomodoroCountdown(before), WORK_MINUTES * 60);

    expect(attribute(after, 'data-timer-phase')).toBe('work');
    expect(taskTimerStart(after)).toBe(taskTimerStart(before));
    expect(attribute(after, 'data-pomodoro-start')).toBe(attribute(before, 'data-pomodoro-start'));
    expectAboutSeconds(taskCountdown(after), WORK_MINUTES * 60);
    expectAboutSeconds(pomodoroCountdown(after), WORK_MINUTES * 60);
    expect(after).toContain('Write the accessibility tests');  // the time tracker, still there
  });
});

describe('time that passed while the server was down', () => {
  test('is taken off the remaining time, not given back', async () => {
    const { before, after } = await restartAfter(10 * MINUTE, startBoth);

    expectAboutSeconds(taskCountdown(before), WORK_MINUTES * 60);
    // The whole point: 10 minutes of downtime out of a 25-minute period leaves
    // 15, not a fresh 25.
    expectAboutSeconds(taskCountdown(after), 15 * 60);
    expectAboutSeconds(pomodoroCountdown(after), 15 * 60);
    expect(attribute(after, 'data-timer-phase')).toBe('work');
  });

  test('ends a pomodoro interval that finished while it was down, and holds it', async () => {
    const { after } = await restartAfter(30 * MINUTE, startPomodoro);

    // 30 minutes down, a 25-minute work period: the period is over. It comes
    // back held for the user, exactly as if the server had been up for it.
    expect(after).toContain('data-pomodoro-awaiting="true"');
    expect(after).toContain('Work period 1 of 2 complete');
    expect(after).toContain('Up next: <strong>Short rest</strong>');
    expect(pomodoroRunning(after)).toBe(false);
  });

  test('walks the task timer through the work and rest phases it missed', async () => {
    const { before, after } = await restartAfter(
      (WORK_MINUTES * 60 + REST_SECONDS + 60) * 1000, startTaskTimer);

    // Work ran out, then rest ran out, so the timer is on its second item with
    // a fresh work period -- not still sitting on the first one.
    expect(before).toContain('Item 1 of');
    expect(after).toContain('Item 2 of');
    expect(attribute(after, 'data-timer-phase')).toBe('work');
    expectAboutSeconds(taskCountdown(after), WORK_MINUTES * 60);
    expect(taskTimerStart(after)).not.toBe(taskTimerStart(before));
  });
});

describe('state that is too old to resume', () => {
  test('is discarded rather than restored', async () => {
    const { before, after } = await restartAfter(5 * 60 * MINUTE, startBoth);

    expect(taskTimerRunning(before)).toBe(true);
    expect(taskTimerRunning(after)).toBe(false);
    expect(pomodoroRunning(after)).toBe(false);
    expect(after).not.toContain('data-pomodoro-awaiting');
    // Both widgets are back to offering a start.
    expect(after).toContain('/api/task-timer/start');
    expect(after).toContain('/api/pomodoro/start');
  });
});

describe('a paused timer', () => {
  test('comes back paused, and the downtime does not eat its remaining time', async () => {
    const pauseAfterStarting = async (server) => {
      await startBoth(server);
      await api(server.baseUrl, '/api/task-timer/pause');
      await api(server.baseUrl, '/api/pomodoro/pause');
    };

    const { before, after } = await restartAfter(2 * 60 * MINUTE, pauseAfterStarting);

    expect(before).toContain('data-timer-paused="true"');
    expect(after).toContain('data-timer-paused="true"');
    expect(after).toContain('data-pomodoro-paused="true"');

    // Paused means the clock is frozen, here as everywhere else: two hours of
    // downtime takes nothing off a timer that was not running.
    expect(taskCountdown(after)).toBe(taskCountdown(before));
    expect(pomodoroCountdown(after)).toBe(pomodoroCountdown(before));

    // And resuming still hands back the time it was holding.
    const resumed = await withServer(async (server) => {
      await api(server.baseUrl, '/api/task-timer/resume');
      await api(server.baseUrl, '/api/pomodoro/resume');
      return home(server.baseUrl);
    });
    expect(resumed).not.toContain('data-timer-paused');
    expectAboutSeconds(taskCountdown(resumed), taskCountdown(before));
    expectAboutSeconds(pomodoroCountdown(resumed), pomodoroCountdown(before));
  });
});

describe('stopping a timer', () => {
  test('is persisted too, so a restart does not resurrect it', async () => {
    const startThenStop = async (server) => {
      await startBoth(server);
      await api(server.baseUrl, '/api/task-timer/stop');
      await api(server.baseUrl, '/api/pomodoro/stop');
    };

    const { after } = await restartAfter(0, startThenStop);
    expect(taskTimerRunning(after)).toBe(false);
    expect(pomodoroRunning(after)).toBe(false);
  });
});
