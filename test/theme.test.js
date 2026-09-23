import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';

import { getNavbar } from '../src/web/navbar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadCommonJsContext(options = {}) {
  const {
    prefersDark = false,
    windowOverrides = {},
    documentOverrides = {},
    locationOverrides = {},
    localStorageOverrides = {},
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    consoleImpl = console,
    fetchImpl = () => Promise.reject(new Error('fetch not stubbed')),
  } = options;
  const sourcePath = path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'common.js');
  const source = fs.readFileSync(sourcePath, 'utf8');

  const storage = new Map();
  const location = {
    href: '',
    reload: () => {},
    ...locationOverrides,
  };
  const context = {
    window: {
      innerWidth: 1280,
      addEventListener: () => {},
      matchMedia: () => ({
        matches: prefersDark,
        addEventListener: () => {},
      }),
      location,
      ...windowOverrides,
    },
    location,
    document: {
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      documentElement: {
        dataset: {},
        setAttribute(name, value) {
          this.dataset[name.replace(/^data-/, '')] = value;
        },
      },
      ...documentOverrides,
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      ...localStorageOverrides,
    },
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval: setIntervalImpl,
    console: consoleImpl,
    fetch: fetchImpl,
  };

  vm.createContext(context);
  vm.runInContext(source, context);

  return context;
}

describe('theme behavior', () => {
  test('theme mode cycle order is system -> dark -> light -> system', () => {
    const context = loadCommonJsContext();
    expect(context.getNextThemeMode('system')).toBe('dark');
    expect(context.getNextThemeMode('dark')).toBe('light');
    expect(context.getNextThemeMode('light')).toBe('system');
  });

  test('getEffectiveTheme respects explicit and system modes', () => {
    const darkSystemContext = loadCommonJsContext({ prefersDark: true });
    expect(darkSystemContext.getEffectiveTheme('system')).toBe('dark');
    expect(darkSystemContext.getEffectiveTheme('dark')).toBe('dark');
    expect(darkSystemContext.getEffectiveTheme('light')).toBe('light');

    const lightSystemContext = loadCommonJsContext({ prefersDark: false });
    expect(lightSystemContext.getEffectiveTheme('system')).toBe('light');
  });
});

describe('navbar rendering', () => {
  test('getNavbar renders theme toggle button', () => {
    const navbarHtml = getNavbar();
    expect(navbarHtml).toContain('id="themeToggleBtn"');
    expect(navbarHtml).toContain('id="themeToggleIcon"');
  });
});

describe('task timer audio behavior', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // The banner is swapped in place rather than reloading the page, so the
  // document — and with it the audio unlock — survives from phase to phase.
  function widgetContainer() {
    return { id: 'taskTimerWidget', outerHTML: '<div id="taskTimerWidget"></div>' };
  }

  function stubbedFetch(container, { ok = true } = {}) {
    return jest.fn(() => (ok
      ? Promise.resolve({ ok: true, text: () => Promise.resolve('<div id="taskTimerWidget">next</div>') })
      : Promise.resolve({ ok: false, status: 500 })));
  }

  test('unlockTaskTimerAudio swallows blocked autoplay resume rejections', async () => {
    const blocked = new Error('autoplay blocked');
    const ctx = {
      state: 'suspended',
      resume: jest.fn(() => Promise.reject(blocked)),
    };
    const AudioContext = jest.fn(() => ctx);
    const unhandled = [];
    const onUnhandled = (reason) => {
      unhandled.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);
    try {
      const context = loadCommonJsContext({
        windowOverrides: { AudioContext },
      });

      context.unlockTaskTimerAudio();
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(AudioContext).toHaveBeenCalledTimes(1);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  test('task timer chimes, then swaps the banner in place without reloading', async () => {
    jest.useFakeTimers();

    const countdownSpan = { textContent: '' };
    const timerAlert = {
      dataset: {
        timerPaused: 'false',
        timerStart: new Date(Date.now() - 5_000).toISOString(),
        timerTotalSeconds: '5',
        timerPhase: 'work',
      },
      querySelector(selector) {
        return selector === '.task-timer-countdown' ? countdownSpan : null;
      },
    };
    const oscillatorStarts = [];
    const reload = jest.fn();
    const ctx = {
      state: 'running',
      currentTime: 0,
      destination: {},
      resume: jest.fn(() => Promise.resolve()),
      createOscillator: jest.fn(() => ({
        type: '',
        frequency: { value: 0 },
        connect: jest.fn(),
        start: jest.fn((at) => oscillatorStarts.push(at)),
        stop: jest.fn(),
      })),
      createGain: jest.fn(() => ({
        connect: jest.fn(),
        gain: {
          setValueAtTime: jest.fn(),
          exponentialRampToValueAtTime: jest.fn(),
        },
      })),
    };
    const container = widgetContainer();
    const fetchImpl = stubbedFetch(container);
    const context = loadCommonJsContext({
      windowOverrides: { AudioContext: jest.fn(() => ctx) },
      documentOverrides: {
        querySelector: (selector) => (selector === '[data-timer-total-seconds]' ? timerAlert : null),
        getElementById: (id) => (id === 'taskTimerWidget' ? container : null),
      },
      locationOverrides: { reload },
      fetchImpl,
    });

    context.updateTaskTimerCountdown();
    context.updateTaskTimerCountdown();
    context.updateTaskTimerCountdown();

    expect(countdownSpan.textContent).toBe('0:00');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    expect(oscillatorStarts).toEqual([0, 0.18]);
    expect(fetchImpl).not.toHaveBeenCalled();

    // The advance runs on its own timer rather than waiting on the chime to
    // resolve, but is still long enough for both notes to sound.
    await jest.advanceTimersByTimeAsync(539);
    expect(fetchImpl).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/task-timer/widget');

    // The page must not reload: that would discard the audio unlock.
    await jest.advanceTimersByTimeAsync(50);
    expect(reload).not.toHaveBeenCalled();
    expect(container.outerHTML).toBe('<div id="taskTimerWidget">next</div>');
  });

  test('task timer advances silently when autoplay is still blocked', async () => {
    jest.useFakeTimers();

    const countdownSpan = { textContent: '' };
    const timerAlert = {
      dataset: {
        timerPaused: 'false',
        timerStart: new Date(Date.now() - 5_000).toISOString(),
        timerTotalSeconds: '5',
        timerPhase: 'rest',
      },
      querySelector(selector) {
        return selector === '.task-timer-countdown' ? countdownSpan : null;
      },
    };
    const reload = jest.fn();
    const ctx = {
      state: 'suspended',
      currentTime: 0,
      destination: {},
      resume: jest.fn(() => Promise.reject(new Error('autoplay blocked'))),
      createOscillator: jest.fn(),
      createGain: jest.fn(),
    };
    const container = widgetContainer();
    const fetchImpl = stubbedFetch(container);
    const context = loadCommonJsContext({
      windowOverrides: { AudioContext: jest.fn(() => ctx) },
      documentOverrides: {
        querySelector: (selector) => (selector === '[data-timer-total-seconds]' ? timerAlert : null),
        getElementById: (id) => (id === 'taskTimerWidget' ? container : null),
      },
      locationOverrides: { reload },
      fetchImpl,
    });

    context.updateTaskTimerCountdown();
    await jest.advanceTimersByTimeAsync(540);

    expect(countdownSpan.textContent).toBe('0:00');
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  // The regression this guards: a refused AudioContext does not reject
  // resume(), it leaves the promise pending. Chaining the reload to the chime
  // stranded the countdown at 0:00 until the page was reloaded by hand.
  // If the swap cannot happen the timer must not be left stuck at 0:00, so a
  // failed widget request falls back to the old reload.
  test('task timer falls back to reloading when the widget request fails', async () => {
    jest.useFakeTimers();

    const countdownSpan = { textContent: '' };
    const timerAlert = {
      dataset: {
        timerPaused: 'false',
        timerStart: new Date(Date.now() - 5_000).toISOString(),
        timerTotalSeconds: '5',
        timerPhase: 'work',
      },
      querySelector(selector) {
        return selector === '.task-timer-countdown' ? countdownSpan : null;
      },
    };
    const reload = jest.fn();
    const container = widgetContainer();
    const fetchImpl = stubbedFetch(container, { ok: false });
    const context = loadCommonJsContext({
      windowOverrides: { AudioContext: undefined },
      documentOverrides: {
        querySelector: (selector) => (selector === '[data-timer-total-seconds]' ? timerAlert : null),
        getElementById: (id) => (id === 'taskTimerWidget' ? container : null),
      },
      locationOverrides: { reload },
      fetchImpl,
    });

    context.updateTaskTimerCountdown();
    await jest.advanceTimersByTimeAsync(600);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('task timer still advances when a blocked resume never settles', async () => {
    jest.useFakeTimers();

    const countdownSpan = { textContent: '' };
    const timerAlert = {
      dataset: {
        timerPaused: 'false',
        timerStart: new Date(Date.now() - 5_000).toISOString(),
        timerTotalSeconds: '5',
        timerPhase: 'work',
      },
      querySelector(selector) {
        return selector === '.task-timer-countdown' ? countdownSpan : null;
      },
    };
    const reload = jest.fn();
    const ctx = {
      state: 'suspended',
      currentTime: 0,
      destination: {},
      resume: jest.fn(() => new Promise(() => {})),
      createOscillator: jest.fn(),
      createGain: jest.fn(),
    };
    const container = widgetContainer();
    const fetchImpl = stubbedFetch(container);
    const context = loadCommonJsContext({
      windowOverrides: { AudioContext: jest.fn(() => ctx) },
      documentOverrides: {
        querySelector: (selector) => (selector === '[data-timer-total-seconds]' ? timerAlert : null),
        getElementById: (id) => (id === 'taskTimerWidget' ? container : null),
      },
      locationOverrides: { reload },
      fetchImpl,
    });

    context.updateTaskTimerCountdown();
    await jest.advanceTimersByTimeAsync(540);

    expect(countdownSpan.textContent).toBe('0:00');
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
});
