import fs from 'fs';

const commonSource = fs.readFileSync(new URL('../src/web/public/js/common.js', import.meta.url), 'utf8');
const clockSource = commonSource.slice(
  commonSource.indexOf('const FAST_CLOCK_MODE_KEY'),
  commonSource.indexOf('// Fasting card actions')
);

function makeClock(localStorage) {
  const clock = {};
  const label = {};
  const toggle = {};
  const card = {
    dataset: { fastGoalHours: '16', fastStart: new Date(Date.now() - 3600000).toISOString() },
    querySelector: selector => ({
      '.fast-clock': clock,
      '.fast-progress-label': label,
      '.fast-mode-toggle': toggle
    })[selector]
  };
  const document = { querySelector: () => card };
  const actions = new Function('localStorage', 'document',
    `${clockSource}; return { getFastClockMode, fastToggleClockMode, updateFastingProgress };`
  )(localStorage, document);
  return { ...actions, clock, label, toggle };
}

describe('fasting clock mode', () => {
  test('keeps the selected mode on subsequent ticks when storage writes fail', () => {
    const storage = {
      getItem: () => 'elapsed',
      setItem: () => { throw new Error('quota exceeded'); }
    };
    const { getFastClockMode, fastToggleClockMode, updateFastingProgress, clock, label, toggle } = makeClock(storage);
    fastToggleClockMode();
    updateFastingProgress();
    expect(getFastClockMode()).toBe('remaining');
    expect(clock.textContent).toContain('left');
    expect(label.textContent).toContain('left');
    expect(toggle.textContent).toBe('Show elapsed');
    fastToggleClockMode();
    updateFastingProgress();
    expect(getFastClockMode()).toBe('elapsed');
    expect(toggle.textContent).toBe('Show remaining');
  });

  test('reads a persisted mode and works when storage is unavailable', () => {
    expect(makeClock({ getItem: () => 'remaining' }).getFastClockMode()).toBe('remaining');
    const clock = makeClock({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); }
    });
    expect(clock.getFastClockMode()).toBe('elapsed');
    clock.fastToggleClockMode();
    clock.updateFastingProgress();
    expect(clock.getFastClockMode()).toBe('remaining');
    expect(clock.clock.textContent).toContain('left');
  });

  test('persists the selected mode for a new page', () => {
    let stored = 'elapsed';
    const storage = {
      getItem: () => stored,
      setItem: (key, value) => { stored = value; }
    };
    makeClock(storage).fastToggleClockMode();
    expect(makeClock(storage).getFastClockMode()).toBe('remaining');
  });
});
