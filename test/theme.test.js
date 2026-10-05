import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

import { getNavbar, getThemeBootstrapScript } from '../src/web/navbar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadCommonJsContext(prefersDark = false) {
  const sourcePath = path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'common.js');
  const source = fs.readFileSync(sourcePath, 'utf8');

  const storage = new Map();
  const windowListeners = {};
  const documentListeners = {};
  const context = {
    window: {
      innerWidth: 1280,
      addEventListener: (name, listener) => { windowListeners[name] = listener; },
      matchMedia: () => ({
        matches: prefersDark,
        addEventListener: () => {},
      }),
      location: { href: '' },
    },
    document: {
      addEventListener: (name, listener) => { documentListeners[name] = listener; },
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      documentElement: {
        dataset: {},
        setAttribute(name, value) {
          this.dataset[name.replace(/^data-/, '')] = value;
        },
      },
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    console,
    windowListeners,
    documentListeners,
  };

  vm.createContext(context);
  vm.runInContext(source, context);

  return context;
}

describe('theme behavior', () => {
  test('invalid stored theme mode falls back to system', () => {
    const context = loadCommonJsContext(true);
    context.localStorage.setItem('todayThemeMode', 'garbage');

    expect(context.getThemeMode()).toBe('system');
    expect(() => context.applyTheme()).not.toThrow();
    expect(context.document.documentElement.dataset.theme).toBe('dark');
  });

  test('theme mode cycle order is system -> dark -> light -> system', () => {
    const context = loadCommonJsContext();
    expect(context.getNextThemeMode('system')).toBe('dark');
    expect(context.getNextThemeMode('dark')).toBe('light');
    expect(context.getNextThemeMode('light')).toBe('system');
  });

  test('getEffectiveTheme respects explicit and system modes', () => {
    const darkSystemContext = loadCommonJsContext(true);
    expect(darkSystemContext.getEffectiveTheme('system')).toBe('dark');
    expect(darkSystemContext.getEffectiveTheme('dark')).toBe('dark');
    expect(darkSystemContext.getEffectiveTheme('light')).toBe('light');

    const lightSystemContext = loadCommonJsContext(false);
    expect(lightSystemContext.getEffectiveTheme('system')).toBe('light');
  });
});

describe('navbar rendering', () => {
  test('getNavbar renders the display settings menu with three theme modes', () => {
    const navbarHtml = getNavbar();
    expect(navbarHtml).toContain('id="displayMenuBtn"');
    expect(navbarHtml).toContain('id="displayMenuPanel"');
    expect(navbarHtml).toContain('data-theme-mode="light"');
    expect(navbarHtml).toContain('data-theme-mode="system"');
    expect(navbarHtml).toContain('data-theme-mode="dark"');
    expect(navbarHtml).not.toContain('themeToggleBtn');

    const brandIndex = navbarHtml.indexOf('class="navbar-brand"');
    const menuIndex = navbarHtml.indexOf('id="displayMenu"');
    const summariesIndex = navbarHtml.indexOf('href="/_summaries"');
    const gitIndex = navbarHtml.indexOf('href="/_git"');
    const searchIndex = navbarHtml.indexOf('id="searchInput"');
    expect(brandIndex).toBeLessThan(menuIndex);
    expect(menuIndex).toBeLessThan(summariesIndex);
    expect(summariesIndex).toBeLessThan(gitIndex);
    expect(gitIndex).toBeLessThan(searchIndex);
    expect(navbarHtml).toContain('class="nav-link text-light px-2 ms-auto" href="/_summaries"');
    expect(navbarHtml).toContain('class="display-menu" id="displayMenu"');
  });

  test('setThemeMode stores the mode, applies it, and marks the matching button', () => {
    const context = loadCommonJsContext(true);
    const buttons = ['light', 'system', 'dark'].map((mode) => ({
      dataset: { themeMode: mode },
      classes: new Set(),
      classList: { toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); } },
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
    }));
    buttons.forEach((b) => { b.classList.owner = b; });
    context.document.querySelectorAll = (sel) => sel === '[data-theme-mode]' ? buttons : [];

    context.setThemeMode('light');
    expect(context.localStorage.getItem('todayThemeMode')).toBe('light');
    expect(context.document.documentElement.dataset.theme).toBe('light');
    expect(buttons[0].classes.has('active')).toBe(true);
    expect(buttons[0].attrs['aria-pressed']).toBe('true');
    expect(buttons[2].classes.has('active')).toBe(false);

    context.setThemeMode('system');
    expect(context.document.documentElement.dataset.theme).toBe('dark');
    expect(buttons[1].classes.has('active')).toBe(true);

    context.setThemeMode('bogus');
    expect(context.localStorage.getItem('todayThemeMode')).toBe('system');
  });

  test('display menu toggles, closes on Escape, and closes on outside click', () => {
    const context = loadCommonJsContext();
    const panel = { classes: new Set(), classList: {
      toggle(name, on) { on ? panel.classes.add(name) : panel.classes.delete(name); },
      contains(name) { return panel.classes.has(name); },
    } };
    const button = { attrs: {}, setAttribute(n, v) { this.attrs[n] = v; }, focused: 0, focus() { this.focused++; } };
    const inside = {};
    const menu = { contains: (el) => el === inside };
    context.document.getElementById = (id) => ({ displayMenuPanel: panel, displayMenuBtn: button, displayMenu: menu })[id] || null;

    context.toggleDisplayMenu({ stopPropagation() {} });
    expect(panel.classes.has('show')).toBe(true);
    expect(button.attrs['aria-expanded']).toBe('true');

    context.documentListeners.click({ target: inside });
    expect(panel.classes.has('show')).toBe(true);

    context.documentListeners.click({ target: {} });
    expect(panel.classes.has('show')).toBe(false);
    expect(button.attrs['aria-expanded']).toBe('false');

    context.toggleDisplayMenu();
    context.documentListeners.keydown({ key: 'Escape' });
    expect(panel.classes.has('show')).toBe(false);
    expect(button.focused).toBe(1);
  });
});

describe('text size behavior', () => {
  test('defaults to iOS Large and steps through the iOS scale', () => {
    const context = loadCommonJsContext();
    context.document.createElement = () => ({ style: {}, remove() {} });
    context.document.documentElement.style = {};
    context.document.documentElement.appendChild = () => {};
    context.getComputedStyle = () => ({ fontSize: '17px' });
    context.CSS = { supports: () => false };

    expect(context.getSystemTextSizeIndex()).toBe(3);
    expect(context.applyTextSize()).toBe(3);
    expect(context.document.documentElement.style.fontSize).toBe('17px');

    context.adjustTextSize(1);
    expect(context.document.documentElement.style.fontSize).toBe('19px');
    expect(context.localStorage.getItem('todayTextSizeOffset')).toBe('1');

    context.adjustTextSize(-2);
    expect(context.document.documentElement.style.fontSize).toBe('16px');
    expect(context.localStorage.getItem('todayTextSizeOffset')).toBe('-1');
  });

  test('tracks the iOS Dynamic Type setting when available', () => {
    const context = loadCommonJsContext();
    context.navigator = { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 1 };
    context.document.createElement = () => ({ style: {}, remove() {} });
    context.document.documentElement.style = {};
    context.document.documentElement.appendChild = () => {};
    context.getComputedStyle = () => ({ fontSize: '21px' });
    context.CSS = { supports: (prop, value) => prop === 'font' && value === '-apple-system-body' };

    expect(context.getSystemTextSizeIndex()).toBe(5);
    expect(context.applyTextSize()).toBe(5);
    expect(context.document.documentElement.style.fontSize).toBe('21px');

    context.adjustTextSize(1);
    expect(context.document.documentElement.style.fontSize).toBe('23px');
  });

  test('ignores the system font keyword on macOS', () => {
    const context = loadCommonJsContext();
    context.navigator = { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 };
    context.document.createElement = () => ({ style: {}, remove() {} });
    context.document.documentElement.style = {};
    context.document.documentElement.appendChild = () => {};
    context.getComputedStyle = () => ({ fontSize: '14px' });
    context.CSS = { supports: () => true };

    expect(context.getSystemTextSizeIndex()).toBe(3);
    expect(context.applyTextSize()).toBe(3);
    expect(context.document.documentElement.style.fontSize).toBe('17px');
  });

  test('clamps at the ends of the scale', () => {
    const context = loadCommonJsContext();
    context.document.createElement = () => ({ style: {}, remove() {} });
    context.document.documentElement.style = {};
    context.document.documentElement.appendChild = () => {};
    context.CSS = { supports: () => false };

    for (let i = 0; i < 20; i++) context.adjustTextSize(1);
    expect(context.document.documentElement.style.fontSize).toBe('53px');
    for (let i = 0; i < 40; i++) context.adjustTextSize(-1);
    expect(context.document.documentElement.style.fontSize).toBe('14px');
  });

  test('getNavbar renders text size controls inside the display menu', () => {
    const navbarHtml = getNavbar();
    expect(navbarHtml).toContain('id="textSizeDownBtn"');
    expect(navbarHtml).toContain('id="textSizeUpBtn"');
    expect(navbarHtml).toContain('id="textSizeLabel"');
    expect(navbarHtml).toContain('id="textSizeResetBtn"');
    expect(navbarHtml).toContain('aria-label="Reset text size to device setting" title="Reset text size to device setting"');
  });

  test('reset returns to the device size and the reset button tracks the offset', () => {
    const context = loadCommonJsContext();
    context.document.createElement = () => ({ style: {}, remove() {} });
    context.document.documentElement.style = {};
    context.document.documentElement.appendChild = () => {};
    context.CSS = { supports: () => false };
    const reset = { disabled: null };
    const hint = { textContent: '' };
    context.document.getElementById = (id) => ({ textSizeResetBtn: reset, textSizeHint: hint })[id] || null;

    context.applyTextSize();
    expect(reset.disabled).toBe(true);
    expect(hint.textContent).toBe('Matches your device setting');

    context.adjustTextSize(2);
    expect(context.document.documentElement.style.fontSize).toBe('21px');
    expect(reset.disabled).toBe(false);
    expect(hint.textContent).toBe('Device setting: Large');

    context.resetTextSize();
    expect(context.document.documentElement.style.fontSize).toBe('17px');
    expect(context.localStorage.getItem('todayTextSizeOffset')).toBe('0');
    expect(reset.disabled).toBe(true);
  });

  test('reset stays enabled when an override is clamped at AX5', () => {
    const context = loadCommonJsContext();
    context.navigator = { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 1 };
    context.document.createElement = () => ({ style: {}, remove() {} });
    context.document.documentElement.style = {};
    context.document.documentElement.appendChild = () => {};
    context.getComputedStyle = () => ({ fontSize: '53px' });
    context.CSS = { supports: (prop, value) => prop === 'font' && value === '-apple-system-body' };
    const reset = { disabled: null };
    const hint = { textContent: '' };
    context.document.getElementById = (id) => ({ textSizeResetBtn: reset, textSizeHint: hint })[id] || null;
    context.localStorage.setItem('todayTextSizeOffset', '2');

    expect(context.getSystemTextSizeIndex()).toBe(11);
    expect(context.applyTextSize()).toBe(11);
    expect(context.document.documentElement.style.fontSize).toBe('53px');
    expect(reset.disabled).toBe(false);
    expect(hint.textContent).toBe('Device setting: AX5');

    context.resetTextSize();
    expect(context.localStorage.getItem('todayTextSizeOffset')).toBe('0');
    expect(reset.disabled).toBe(true);
    expect(hint.textContent).toBe('Matches your device setting');
  });

  test('announces text size changes and reapplies size on restore and visibility', () => {
    const context = loadCommonJsContext();
    context.document.createElement = () => ({ style: {}, remove() {} });
    context.document.documentElement.style = {};
    context.document.documentElement.appendChild = () => {};
    context.getComputedStyle = () => ({ fontSize: '17px' });
    context.CSS = { supports: () => false };
    const label = { textContent: '', title: '' };
    context.document.getElementById = (id) => id === 'textSizeLabel' ? label : null;

    context.adjustTextSize(1);
    expect(label.textContent).toBe('Extra Large');
    expect(label.title).toBe('Text size: Extra Large');
    expect(context.document.documentElement.style.fontSize).toBe('19px');

    context.localStorage.setItem('todayTextSizeOffset', '0');
    context.windowListeners.pageshow();
    expect(context.document.documentElement.style.fontSize).toBe('17px');

    context.localStorage.setItem('todayTextSizeOffset', '1');
    context.document.visibilityState = 'visible';
    context.documentListeners.visibilitychange();
    expect(context.document.documentElement.style.fontSize).toBe('19px');
  });

  test('bootstrap applies iOS text size again after page restore and visibility', () => {
    const bootstrap = getThemeBootstrapScript();
    const script = bootstrap.slice('<script>'.length, -'</script>'.length);
    const windowListeners = {};
    const documentListeners = {};
    const storage = new Map([['todayTextSizeOffset', '0']]);
    let systemSize = '21px';
    const documentElement = {
      dataset: {},
      style: {},
      appendChild() {},
    };
    const context = {
      CSS: { supports: () => true },
      document: {
        documentElement,
        createElement: () => ({ style: {}, remove() {} }),
        addEventListener: (name, listener) => { documentListeners[name] = listener; },
      },
      getComputedStyle: () => ({ fontSize: systemSize }),
      localStorage: {
        getItem: (key) => storage.get(key) || null,
      },
      navigator: { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 1 },
      window: {
        addEventListener: (name, listener) => { windowListeners[name] = listener; },
        matchMedia: () => ({ matches: false }),
      },
    };

    vm.runInNewContext(script, context);
    expect(documentElement.style.fontSize).toBe('21px');
    systemSize = '23px';
    windowListeners.pageshow();
    expect(documentElement.style.fontSize).toBe('23px');
    systemSize = '19px';
    context.document.visibilityState = 'visible';
    documentListeners.visibilitychange();
    expect(documentElement.style.fontSize).toBe('19px');
  });
});
