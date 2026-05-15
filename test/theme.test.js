import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

import { getNavbar } from '../src/web/navbar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadCommonJsContext(prefersDark = false) {
  const sourcePath = path.join(__dirname, '..', 'src', 'web', 'public', 'js', 'common.js');
  const source = fs.readFileSync(sourcePath, 'utf8');

  const storage = new Map();
  const context = {
    window: {
      innerWidth: 1280,
      addEventListener: () => {},
      matchMedia: () => ({
        matches: prefersDark,
        addEventListener: () => {},
      }),
      location: { href: '' },
    },
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
    const darkSystemContext = loadCommonJsContext(true);
    expect(darkSystemContext.getEffectiveTheme('system')).toBe('dark');
    expect(darkSystemContext.getEffectiveTheme('dark')).toBe('dark');
    expect(darkSystemContext.getEffectiveTheme('light')).toBe('light');

    const lightSystemContext = loadCommonJsContext(false);
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
