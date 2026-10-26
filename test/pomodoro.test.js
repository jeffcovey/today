import fs from 'fs';
import vm from 'node:vm';
import { jest } from '@jest/globals';
import {
  getPomodoroConfig, nextInterval, intervalDescription, phaseLabel,
  phaseMinutes, phaseDurationMs,
  createPomodoroState, startPomodoro, holdInterval, startHeldInterval,
  skipInterval, pausePomodoro, resumePomodoro, remainingMs, isIntervalOver,
  PHASE_WORK, PHASE_SHORT_REST, PHASE_LONG_REST,
  NUDGE_INTERVAL_MS, MAX_NUDGES
} from '../src/pomodoro.js';

/**
 * Pomodoro Timer Tests
 *
 * Covers config parsing (the section is hand-edited, so it must survive junk),
 * the interval sequence, and the route wiring that stops the repeating
 * notifications once the user answers.
 */

const config = (overrides = {}) => getPomodoroConfig({
  enabled: true, work_periods: 4, work_minutes: 25,
  short_rest_minutes: 5, long_rest_minutes: 15, ...overrides
});

// Walk the state machine for `count` intervals from a fresh start.
function runSequence(cfg, count) {
  const out = [];
  let phase = PHASE_WORK;
  let periodIndex = 0;
  for (let i = 0; i < count; i++) {
    out.push(intervalDescription(phase, periodIndex, cfg));
    ({ phase, periodIndex } = nextInterval(phase, periodIndex, cfg));
  }
  return out;
}

describe('getPomodoroConfig – opt-in', () => {
  test('is disabled when the section is absent', () => {
    expect(getPomodoroConfig(undefined).enabled).toBe(false);
    expect(getPomodoroConfig(null).enabled).toBe(false);
    expect(getPomodoroConfig({}).enabled).toBe(false);
  });

  test('is enabled only by an explicit true', () => {
    expect(getPomodoroConfig({ enabled: true }).enabled).toBe(true);
    expect(getPomodoroConfig({ enabled: 'yes' }).enabled).toBe(false);
    expect(getPomodoroConfig({ enabled: 1 }).enabled).toBe(false);
    expect(getPomodoroConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe('getPomodoroConfig – defaults and clamping', () => {
  test('supplies classic pomodoro defaults', () => {
    const cfg = getPomodoroConfig({ enabled: true });
    expect(cfg).toMatchObject({
      workPeriods: 4, workMinutes: 25, shortRestMinutes: 5, longRestMinutes: 15
    });
  });

  test('honours configured values', () => {
    const cfg = config({ work_periods: 3, work_minutes: 50, short_rest_minutes: 10, long_rest_minutes: 30 });
    expect(cfg).toMatchObject({
      workPeriods: 3, workMinutes: 50, shortRestMinutes: 10, longRestMinutes: 30
    });
  });

  test('falls back on values that would break the clock', () => {
    // A zero or negative duration would make an interval end the moment it starts.
    expect(config({ work_minutes: 0 }).workMinutes).toBe(25);
    expect(config({ work_minutes: -5 }).workMinutes).toBe(25);
    expect(config({ work_periods: 0 }).workPeriods).toBe(4);
    expect(config({ short_rest_minutes: 'abc' }).shortRestMinutes).toBe(5);
    expect(config({ long_rest_minutes: null }).longRestMinutes).toBe(15);
  });

  test('accepts numeric strings from TOML-ish input', () => {
    expect(config({ work_minutes: '45' }).workMinutes).toBe(45);
  });

  test('rounds fractional minutes', () => {
    expect(config({ work_minutes: 25.6 }).workMinutes).toBe(26);
  });

  test('clamps absurd values instead of trusting them', () => {
    expect(config({ work_minutes: 10000 }).workMinutes).toBe(180);
    expect(config({ work_periods: 500 }).workPeriods).toBe(12);
  });
});

describe('nextInterval – the cycle', () => {
  test('a work period is followed by a short rest', () => {
    expect(nextInterval(PHASE_WORK, 0, config())).toEqual({ phase: PHASE_SHORT_REST, periodIndex: 0 });
  });

  test('a short rest advances to the next work period', () => {
    expect(nextInterval(PHASE_SHORT_REST, 0, config())).toEqual({ phase: PHASE_WORK, periodIndex: 1 });
  });

  test('the last work period of the cycle is followed by the long rest', () => {
    expect(nextInterval(PHASE_WORK, 3, config())).toEqual({ phase: PHASE_LONG_REST, periodIndex: 3 });
  });

  test('the long rest restarts the cycle at the first work period', () => {
    expect(nextInterval(PHASE_LONG_REST, 3, config())).toEqual({ phase: PHASE_WORK, periodIndex: 0 });
  });

  test('runs work/short-rest pairs then a long rest, then repeats', () => {
    expect(runSequence(config({ work_periods: 3 }), 8)).toEqual([
      'Work period 1 of 3', 'Short rest',
      'Work period 2 of 3', 'Short rest',
      'Work period 3 of 3', 'Long rest',
      'Work period 1 of 3', 'Short rest'
    ]);
  });

  test('a single-period cycle alternates work and long rest', () => {
    expect(runSequence(config({ work_periods: 1 }), 4)).toEqual([
      'Work period 1 of 1', 'Long rest', 'Work period 1 of 1', 'Long rest'
    ]);
  });

  test('never emits a short rest when there is only one work period', () => {
    expect(runSequence(config({ work_periods: 1 }), 20)).not.toContain('Short rest');
  });
});

describe('interval durations', () => {
  test('each phase draws on its own configured length', () => {
    const cfg = config({ work_minutes: 25, short_rest_minutes: 5, long_rest_minutes: 15 });
    expect(phaseMinutes(PHASE_WORK, cfg)).toBe(25);
    expect(phaseMinutes(PHASE_SHORT_REST, cfg)).toBe(5);
    expect(phaseMinutes(PHASE_LONG_REST, cfg)).toBe(15);
  });

  test('converts to milliseconds for the boundary timer', () => {
    expect(phaseDurationMs(PHASE_WORK, config({ work_minutes: 25 }))).toBe(25 * 60 * 1000);
    expect(phaseDurationMs(PHASE_SHORT_REST, config({ short_rest_minutes: 5 }))).toBe(5 * 60 * 1000);
  });
});

describe('labels', () => {
  test('names each phase for the banner', () => {
    expect(phaseLabel(PHASE_WORK)).toBe('Work');
    expect(phaseLabel(PHASE_SHORT_REST)).toBe('Short rest');
    expect(phaseLabel(PHASE_LONG_REST)).toBe('Long rest');
  });

  test('a work period is described with its position in the cycle', () => {
    expect(intervalDescription(PHASE_WORK, 1, config())).toBe('Work period 2 of 4');
  });

  test('rests are described without a position', () => {
    expect(intervalDescription(PHASE_SHORT_REST, 1, config())).toBe('Short rest');
    expect(intervalDescription(PHASE_LONG_REST, 3, config())).toBe('Long rest');
  });
});

describe('notification cadence', () => {
  test('repeats every two minutes, five times at most', () => {
    expect(NUDGE_INTERVAL_MS).toBe(2 * 60 * 1000);
    expect(MAX_NUDGES).toBe(5);
  });
});

const MIN = 60 * 1000;

describe('state machine – starting', () => {
  test('a fresh state is idle', () => {
    const state = createPomodoroState();
    expect(state.isRunning).toBe(false);
    expect(state.startTime).toBeNull();
    expect(state.awaitingStart).toBe(false);
  });

  test('starting begins the first work period', () => {
    const state = startPomodoro(new Date(0));
    expect(state).toMatchObject({
      isRunning: true, isPaused: false, awaitingStart: false,
      phase: PHASE_WORK, periodIndex: 0
    });
    expect(state.startTime).toBe(new Date(0).toISOString());
  });
});

describe('state machine – remaining time', () => {
  const cfg = config({ work_minutes: 25 });

  test('counts down from the full interval', () => {
    const state = startPomodoro(new Date(0));
    expect(remainingMs(state, cfg, 0)).toBe(25 * MIN);
    expect(remainingMs(state, cfg, 10 * MIN)).toBe(15 * MIN);
  });

  test('never goes negative', () => {
    const state = startPomodoro(new Date(0));
    expect(remainingMs(state, cfg, 90 * MIN)).toBe(0);
  });

  test('freezes while paused, however long the pause lasts', () => {
    const paused = pausePomodoro(startPomodoro(new Date(0)), new Date(10 * MIN));
    expect(remainingMs(paused, cfg, 10 * MIN)).toBe(15 * MIN);
    expect(remainingMs(paused, cfg, 300 * MIN)).toBe(15 * MIN);
  });
});

describe('state machine – the hold at the end of an interval', () => {
  const cfg = config({ work_periods: 2, work_minutes: 25 });

  test('an interval that has run its length is over', () => {
    const state = startPomodoro(new Date(0));
    expect(isIntervalOver(state, cfg, 25 * MIN - 1)).toBe(false);
    expect(isIntervalOver(state, cfg, 25 * MIN)).toBe(true);
  });

  test('holding records what finished and names what is next', () => {
    const held = holdInterval(startPomodoro(new Date(0)), cfg);
    expect(held.awaitingStart).toBe(true);
    expect(held.finishedPhase).toBe(PHASE_WORK);
    expect(held.finishedPeriodIndex).toBe(0);
    expect(held.phase).toBe(PHASE_SHORT_REST);
  });

  test('nothing runs during the hold, no matter how much time passes', () => {
    const held = holdInterval(startPomodoro(new Date(0)), cfg);
    expect(held.startTime).toBeNull();
    // This is the whole point of the feature: the next interval does not begin
    // on its own while the user is away from the desk.
    expect(isIntervalOver(held, cfg, 999 * MIN)).toBe(false);
    expect(held.isRunning).toBe(true);
  });

  test('starting the held interval begins it from that moment', () => {
    const held = holdInterval(startPomodoro(new Date(0)), cfg);
    const next = startHeldInterval(held, new Date(40 * MIN));
    expect(next.awaitingStart).toBe(false);
    expect(next.phase).toBe(PHASE_SHORT_REST);
    expect(next.startTime).toBe(new Date(40 * MIN).toISOString());
    // The time spent waiting is not deducted from the rest.
    expect(remainingMs(next, cfg, 40 * MIN)).toBe(5 * MIN);
  });

  test('holding resets the reminder count for the new interval', () => {
    const held = holdInterval({ ...startPomodoro(new Date(0)), nudgeCount: 4 }, cfg);
    expect(held.nudgeCount).toBe(0);
  });
});

describe('state machine – pause and resume', () => {
  const cfg = config({ work_minutes: 25 });

  test('resuming keeps the time the interval had left', () => {
    const state = startPomodoro(new Date(0));
    const paused = pausePomodoro(state, new Date(10 * MIN));
    const resumed = resumePomodoro(paused, 30 * MIN); // paused for 20 minutes
    expect(resumed.isPaused).toBe(false);
    expect(resumed.pausedAt).toBeNull();
    expect(remainingMs(resumed, cfg, 30 * MIN)).toBe(15 * MIN);
  });

  test('a paused interval is never treated as over', () => {
    const paused = pausePomodoro(startPomodoro(new Date(0)), new Date(1 * MIN));
    expect(isIntervalOver(paused, cfg, 999 * MIN)).toBe(false);
  });
});

describe('state machine – skipping', () => {
  const cfg = config({ work_periods: 2 });

  test('skipping starts the next interval at once, with no hold', () => {
    const skipped = skipInterval(startPomodoro(new Date(0)), cfg, new Date(5 * MIN));
    expect(skipped.awaitingStart).toBe(false);
    expect(skipped.phase).toBe(PHASE_SHORT_REST);
    expect(skipped.startTime).toBe(new Date(5 * MIN).toISOString());
  });

  test('skipping clears a pause rather than carrying it over', () => {
    const paused = pausePomodoro(startPomodoro(new Date(0)), new Date(1 * MIN));
    const skipped = skipInterval(paused, cfg, new Date(2 * MIN));
    expect(skipped.isPaused).toBe(false);
    expect(skipped.pausedAt).toBeNull();
  });

  test('repeated skips walk the cycle', () => {
    let state = startPomodoro(new Date(0));
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(intervalDescription(state.phase, state.periodIndex, cfg));
      state = skipInterval(state, cfg, new Date(0));
    }
    expect(seen).toEqual(['Work period 1 of 2', 'Short rest', 'Work period 2 of 2', 'Long rest']);
  });
});

describe('state machine – a whole session', () => {
  // Drive it the way the server does: let each interval run out, hold, then
  // start the next one.
  function driveSession(cfg, intervalCount) {
    let state = startPomodoro(new Date(0));
    let now = 0;
    const ran = [];

    for (let i = 0; i < intervalCount; i++) {
      ran.push(intervalDescription(state.phase, state.periodIndex, cfg));

      now += phaseDurationMs(state.phase, cfg);
      expect(isIntervalOver(state, cfg, now)).toBe(true);

      state = holdInterval(state, cfg);
      expect(state.startTime).toBeNull();

      now += 3 * MIN; // the user takes a moment to come back
      state = startHeldInterval(state, new Date(now));
    }
    return ran;
  }

  test('runs the configured cycle and repeats it, holding at every boundary', () => {
    expect(driveSession(config({ work_periods: 2 }), 6)).toEqual([
      'Work period 1 of 2', 'Short rest',
      'Work period 2 of 2', 'Long rest',
      'Work period 1 of 2', 'Short rest'
    ]);
  });

  test('a four-period cycle reaches the long rest only after the fourth', () => {
    const ran = driveSession(config({ work_periods: 4 }), 8);
    expect(ran.filter(i => i === 'Long rest')).toHaveLength(1);
    expect(ran[7]).toBe('Long rest');
  });
});

// ── Route wiring ─────────────────────────────────────────────────────────────

const webServerSource = fs.readFileSync(new URL('../src/web-server.js', import.meta.url), 'utf8');

describe('pomodoro server timers', () => {
  let cfg;
  let timer;
  let sendPushover;
  let persistTimers;

  beforeEach(() => {
    jest.useFakeTimers();
    cfg = config();
    sendPushover = jest.fn().mockResolvedValue({ sent: true });
    // The real one writes .data/timer-state.json so the session survives a
    // restart (#655); here it only has to record that it was called.
    persistTimers = jest.fn().mockResolvedValue(undefined);
    const source = webServerSource.slice(
      webServerSource.indexOf('let pomodoroState ='),
      webServerSource.indexOf('function pomodoroButton(')
    );
    timer = vm.runInNewContext(`${source}
      ({
        start() {
          pomodoroState = startPomodoro();
          armPomodoroBoundary();
        },
        advancePomodoroIfNeeded,
        stopPomodoro,
        getState: () => pomodoroState
      });
    `, {
      Date, setTimeout, clearTimeout, console,
      createPomodoroState, startPomodoro, remainingMs, isIntervalOver,
      holdInterval, intervalDescription, phaseMinutes, NUDGE_INTERVAL_MS, MAX_NUDGES,
      getPomodoroConfig: () => cfg,
      getPublicBaseUrl: () => '',
      sendPushover,
      persistTimers
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('re-arms the boundary when a running interval gets longer', () => {
    timer.start();
    cfg = config({ work_minutes: 50 });
    jest.advanceTimersByTime(25 * 60 * 1000 + 250);
    expect(timer.getState().awaitingStart).toBe(false);
    expect(sendPushover).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(25 * 60 * 1000);
    expect(timer.getState().awaitingStart).toBe(true);
    expect(sendPushover).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  test('disabling before the boundary resets the session without notifying', () => {
    timer.start();
    cfg = config({ enabled: false });
    jest.advanceTimersByTime(25 * 60 * 1000 + 250);
    expect(timer.getState()).toEqual(createPomodoroState());
    expect(sendPushover).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('checking a disabled session before completion cancels its boundary', () => {
    timer.start();
    cfg = config({ enabled: false });
    timer.advancePomodoroIfNeeded();
    expect(timer.getState()).toEqual(createPomodoroState());
    expect(jest.getTimerCount()).toBe(0);
    expect(sendPushover).not.toHaveBeenCalled();
  });

  test('disabling during a hold cancels further reminders and resets the session', () => {
    timer.start();
    jest.advanceTimersByTime(25 * 60 * 1000 + 250);
    expect(sendPushover).toHaveBeenCalledTimes(1);

    cfg = config({ enabled: false });
    jest.advanceTimersByTime(NUDGE_INTERVAL_MS);
    expect(timer.getState()).toEqual(createPomodoroState());
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(MAX_NUDGES * NUDGE_INTERVAL_MS);
    expect(sendPushover).toHaveBeenCalledTimes(1);
  });

  test.each(['running', 'holding'])('stopping a %s session clears its timers', (state) => {
    timer.start();
    if (state === 'holding') jest.advanceTimersByTime(25 * 60 * 1000 + 250);
    timer.stopPomodoro();
    expect(timer.getState()).toEqual(createPomodoroState());
    expect(jest.getTimerCount()).toBe(0);
  });

  test('saves the session when an interval ends and when it is stopped', () => {
    timer.start();
    persistTimers.mockClear();

    jest.advanceTimersByTime(25 * 60 * 1000 + 250);
    expect(persistTimers).toHaveBeenCalledTimes(1);   // the hold

    timer.stopPomodoro();
    expect(persistTimers).toHaveBeenCalledTimes(2);   // and the stop
  });
});

function routeBody(source, routePath) {
  const marker = `app.post('${routePath}'`;
  const start = source.indexOf(marker);
  if (start === -1) return null;

  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) return null;

  let depth = 0;
  for (let index = braceStart; index < source.length; index++) {
    const char = source[index];
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, index + 1);
    }
  }
  return null;
}

describe('opt-in and placement', () => {
  test('the widget renders nothing unless the config enables it', () => {
    const start = webServerSource.indexOf('function getPomodoroWidget()');
    expect(start).toBeGreaterThan(-1);
    expect(webServerSource.slice(start, start + 300)).toContain("if (!config.enabled) return '';");
  });

  test('starting is refused while the feature is off', () => {
    expect(routeBody(webServerSource, '/api/pomodoro/start')).toContain('getPomodoroConfig().enabled');
  });

  // Both widgets used to be pasted into three page builders, and these two
  // tests counted the copies. They are built in one place now, so the thing to
  // check is that the one place is used everywhere and puts them in order.
  function activityBarBody() {
    const start = webServerSource.indexOf('async function getActivityBar(');
    expect(start).toBeGreaterThan(-1);
    const end = webServerSource.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    return webServerSource.slice(start, end);
  }

  test('it appears on every page that carries the task timer', () => {
    const bars = webServerSource.match(/await getActivityBar\(/g) || [];
    expect(bars).toHaveLength(3);

    const body = activityBarBody();
    expect(body).toContain('await getTaskTimerWidget()');
    expect(body).toContain('getPomodoroWidget()');
  });

  test('each banner sits directly under the task timer, not above it', () => {
    const body = activityBarBody();
    expect(body.indexOf('getPomodoroWidget()'))
      .toBeGreaterThan(body.indexOf('await getTaskTimerWidget()'));
    // And the order survives placement: whichever list each one lands in, the
    // task timer is pushed first.
    expect(body.indexOf('pomodoroHtml)')).toBeGreaterThan(body.indexOf('taskTimerHtml)'));
  });
});

describe('pomodoro route wiring', () => {
  const routes = ['start', 'stop', 'next', 'skip', 'pause', 'resume'];

  test('every control the widget offers has a route', () => {
    for (const route of routes) {
      expect(routeBody(webServerSource, `/api/pomodoro/${route}`)).not.toBeNull();
    }
  });

  test('stopping and starting the next interval both silence the reminders', () => {
    // These are the two answers the spec says must end the repeat. stopPomodoro()
    // cancels the boundary and the reminders together, which the fake-timer tests
    // above exercise directly.
    expect(routeBody(webServerSource, '/api/pomodoro/stop')).toContain('stopPomodoro()');
    expect(routeBody(webServerSource, '/api/pomodoro/next')).toContain('clearPomodoroNudges()');
  });

  test('every route that starts a clock arms a boundary', () => {
    for (const route of ['start', 'next', 'skip', 'resume']) {
      expect(routeBody(webServerSource, `/api/pomodoro/${route}`)).toContain('armPomodoroBoundary()');
    }
  });

  test('pausing clears the boundary rather than arming one', () => {
    const pause = routeBody(webServerSource, '/api/pomodoro/pause');
    expect(pause).toContain('clearPomodoroBoundary()');
    expect(pause).not.toContain('armPomodoroBoundary()');
  });

  test('the pomodoro routes leave the task timer alone', () => {
    for (const route of routes) {
      const body = routeBody(webServerSource, `/api/pomodoro/${route}`);
      expect(body).not.toContain('armTaskTimerBoundary()');
      expect(body).not.toContain('taskTimerState');
    }
  });

  test('the task timer routes leave the pomodoro alone', () => {
    for (const route of ['start', 'stop', 'skip', 'pause', 'resume']) {
      const body = routeBody(webServerSource, `/api/task-timer/${route}`);
      expect(body).not.toContain('pomodoroState');
      expect(body).not.toContain('armPomodoroBoundary()');
    }
  });
});
