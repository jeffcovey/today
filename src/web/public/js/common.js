/**
 * Common JavaScript for Today web interface
 */

// Theme functionality
//
// The theme is stored on the server so every device agrees. It reaches the
// browser as a cookie the server sets on each page response, which the head
// script reads before first paint. localStorage keeps the last known value for
// when the cookie is missing or blocked, and so a change applies instantly
// without waiting on the round trip.
const THEME_STORAGE_KEY = 'todayThemeMode';
const THEME_COOKIE_NAME = 'todayThemeMode';
const THEME_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
let themeMediaQuery = null;

function isThemeMode(mode) {
  return mode === 'light' || mode === 'dark' || mode === 'system';
}

function readThemeCookie() {
  try {
    const match = (document.cookie || '').match(/(?:^|;\s*)todayThemeMode=([^;]*)/);
    const mode = match && decodeURIComponent(match[1]);
    return isThemeMode(mode) ? mode : null;
  } catch {
    return null;
  }
}

function writeThemeCookie(mode) {
  try {
    document.cookie = `${THEME_COOKIE_NAME}=${encodeURIComponent(mode)}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
  } catch {
    // Cookies blocked; localStorage still carries this browser through.
  }
}

function getThemeMode() {
  const stored = readThemeCookie();
  if (stored) return stored;
  const mode = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeMode(mode) ? mode : 'system';
}

function getEffectiveTheme(mode) {
  if (mode === 'dark' || mode === 'light') {
    return mode;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeToggle(mode, effectiveTheme) {
  const buttons = document.querySelectorAll('#displayMenuPanel [data-theme-mode]');
  buttons.forEach((button) => {
    const active = button.dataset.themeMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const menuButton = document.getElementById('displayMenuBtn');
  if (menuButton) {
    const themeLabels = { light: 'Light', dark: 'Dark', system: `System (${effectiveTheme})` };
    const themeLabel = themeLabels[mode] || themeLabels.system;
    menuButton.title = `Display settings. Theme: ${themeLabel}`;
  }
}

// MDB and Bootstrap read their own attributes to switch their components
// (buttons, form controls, tables, alerts) between light and dark, so keep all
// three in sync. Mirrors getThemeBootstrapScript() in src/web/navbar.js.
function setThemeAttributes(effectiveTheme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', effectiveTheme);
  root.setAttribute('data-mdb-theme', effectiveTheme);
  root.setAttribute('data-bs-theme', effectiveTheme);
}

function applyTheme(mode = getThemeMode()) {
  const effectiveTheme = getEffectiveTheme(mode);
  setThemeAttributes(effectiveTheme);
  updateThemeToggle(mode, effectiveTheme);
}

function getNextThemeMode(mode) {
  if (mode === 'system') return 'dark';
  if (mode === 'dark') return 'light';
  return 'system';
}

function setThemeMode(mode) {
  const next = isThemeMode(mode) ? mode : 'system';
  // Apply and remember it here first, so the change is instant and survives a
  // server that is slow or unreachable; then tell the server, for the next
  // device that asks.
  try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* storage blocked */ }
  writeThemeCookie(next);
  applyTheme(next);
  return saveThemeMode(next);
}

function saveThemeMode(mode) {
  if (typeof fetch !== 'function') return Promise.resolve();
  return fetch('/api/theme', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  }).catch(() => {
    // Offline or logged out: this browser keeps the choice, and the server
    // learns it the next time one sticks.
  });
}

function cycleThemeMode() {
  setThemeMode(getNextThemeMode(getThemeMode()));
}

// Palettes
//
// A palette is a set of --today-* values; the server serves the chosen one at
// /theme.css. Unlike the mode, it can't be applied here before the round trip:
// the colours live in a stylesheet only the server can write. So the select
// waits for the save, then reloads the one stylesheet rather than the page.

function reloadThemeStylesheet() {
  const link = document.querySelector('link[href^="/theme.css"]');
  if (!link) return;
  // A fresh query string is the only way to make the browser re-ask; the
  // response itself is no-cache, so this costs one request.
  link.href = `/theme.css?changed=${Date.now()}`;
}

function setThemePalette(name) {
  const select = document.getElementById('paletteSelect');
  const previous = select ? select.dataset.selected : null;
  if (typeof fetch !== 'function') return Promise.resolve();
  return fetch('/api/theme', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }).then((response) => {
    if (!response.ok) throw new Error(`Could not save palette: ${response.status}`);
    if (select) select.dataset.selected = name;
    reloadThemeStylesheet();
  }).catch(() => {
    // The palette is whatever the server still has, so put the control back
    // rather than leaving it showing a choice that did not take.
    if (select && previous) select.value = previous;
  });
}

/**
 * Fill the palette row from the vault. It stays hidden unless there is more
 * than the built-in palette, so a vault with no themes sees no empty control.
 */
function initializePalettes() {
  const row = document.getElementById('paletteRow');
  const select = document.getElementById('paletteSelect');
  if (!row || !select || typeof fetch !== 'function') return;
  fetch('/api/themes')
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (!data || !Array.isArray(data.themes) || data.themes.length < 2) return;
      select.textContent = '';
      for (const theme of data.themes) {
        const option = document.createElement('option');
        option.value = theme.id;
        // textContent, not innerHTML: these names come from vault files.
        option.textContent = theme.name;
        select.appendChild(option);
      }
      select.value = data.selected;
      select.dataset.selected = data.selected;
      row.hidden = false;
    })
    .catch(() => {
      // Offline or logged out: the row stays hidden and the page keeps the
      // palette the server already served.
    });
}

function initializeTheme() {
  const mode = getThemeMode();
  const effectiveTheme = getEffectiveTheme(mode);
  if (!document.documentElement.dataset.theme) {
    setThemeAttributes(effectiveTheme);
  }
  // Keep this browser's fallback in step with what the server just told us,
  // so it stays right if the cookie is later cleared.
  try { localStorage.setItem(THEME_STORAGE_KEY, mode); } catch { /* storage blocked */ }
  updateThemeToggle(mode, effectiveTheme);

  themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemThemeChange = () => {
    if (getThemeMode() === 'system') {
      applyTheme('system');
    }
  };

  if (typeof themeMediaQuery.addEventListener === 'function') {
    themeMediaQuery.addEventListener('change', handleSystemThemeChange);
  }
}

// Text size functionality
// Mirrors iOS Dynamic Type body sizes (px). Index 3 ('Large') is the iOS default.
const TEXT_SIZES = [14, 15, 16, 17, 19, 21, 23, 28, 33, 40, 47, 53];
const TEXT_SIZE_NAMES = [
  'Extra Small', 'Small', 'Medium', 'Large', 'Extra Large', 'XX Large', 'XXX Large',
  'AX1', 'AX2', 'AX3', 'AX4', 'AX5',
];
const DEFAULT_TEXT_SIZE_INDEX = 3;
const TEXT_SIZE_STORAGE_KEY = 'todayTextSizeOffset';

function nearestTextSizeIndex(px) {
  return TEXT_SIZES.reduce((best, size, i) =>
    Math.abs(size - px) < Math.abs(TEXT_SIZES[best] - px) ? i : best, 0);
}

// Measure the device's Dynamic Type setting via Safari's -apple-system-body.
// Returns the iOS default outside iOS or when the keyword is unavailable.
function getSystemTextSizeIndex() {
  try {
    const isIOS = typeof navigator !== 'undefined' &&
      (/iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
    if (!isIOS || typeof CSS === 'undefined' || !CSS.supports || !CSS.supports('font', '-apple-system-body')) {
      return DEFAULT_TEXT_SIZE_INDEX;
    }
    const probe = document.createElement('div');
    probe.style.font = '-apple-system-body';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    (document.body || document.documentElement).appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return px > 0 ? nearestTextSizeIndex(px) : DEFAULT_TEXT_SIZE_INDEX;
  } catch {
    return DEFAULT_TEXT_SIZE_INDEX;
  }
}

function getTextSizeOffset() {
  return parseInt(localStorage.getItem(TEXT_SIZE_STORAGE_KEY) || '0', 10) || 0;
}

function clampTextSizeIndex(index) {
  return Math.min(TEXT_SIZES.length - 1, Math.max(0, index));
}

function getTextSizeIndex(systemIndex = getSystemTextSizeIndex(), offset = getTextSizeOffset()) {
  return clampTextSizeIndex(systemIndex + offset);
}

function updateTextSizeControl(index, systemIndex) {
  const label = document.getElementById('textSizeLabel');
  const down = document.getElementById('textSizeDownBtn');
  const up = document.getElementById('textSizeUpBtn');
  const hint = document.getElementById('textSizeHint');
  const reset = document.getElementById('textSizeResetBtn');
  const name = TEXT_SIZE_NAMES[index];
  const hasOverride = getTextSizeOffset() !== 0;
  if (label) {
    label.textContent = name;
    label.title = `Text size: ${name}${hasOverride ? '' : ' (system)'}`;
  }
  if (hint) {
    hint.textContent = hasOverride
      ? `Device setting: ${TEXT_SIZE_NAMES[systemIndex]}`
      : 'Matches your device setting';
  }
  if (reset) reset.disabled = !hasOverride;
  if (down) down.disabled = index <= 0;
  if (up) up.disabled = index >= TEXT_SIZES.length - 1;
}

function applyTextSize() {
  const systemIndex = getSystemTextSizeIndex();
  const index = getTextSizeIndex(systemIndex);
  const zoom = parseFloat(document.documentElement.dataset.zoom) || 100;
  document.documentElement.style.fontSize = `${TEXT_SIZES[index] * zoom / 100}px`;
  updateTextSizeControl(index, systemIndex);
  return index;
}

// Step one iOS text size up (+1) or down (-1), stored as an offset from the
// device setting so the site keeps tracking iOS Text Size changes.
function adjustTextSize(delta) {
  const systemIndex = getSystemTextSizeIndex();
  const current = getTextSizeIndex(systemIndex);
  const next = clampTextSizeIndex(current + delta);
  localStorage.setItem(TEXT_SIZE_STORAGE_KEY, String(next - systemIndex));
  applyTextSize();
}

// Return to the device's own text size.
function resetTextSize() {
  localStorage.setItem(TEXT_SIZE_STORAGE_KEY, '0');
  applyTextSize();
}

function initializeTextSize() {
  applyTextSize();
}

// Display settings menu (gear button in the navbar)
function setDisplayMenuOpen(open) {
  const panel = document.getElementById('displayMenuPanel');
  const button = document.getElementById('displayMenuBtn');
  if (!panel || !button) return;
  panel.classList.toggle('show', open);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function isDisplayMenuOpen() {
  const panel = document.getElementById('displayMenuPanel');
  return Boolean(panel && panel.classList.contains('show'));
}

function toggleDisplayMenu(event) {
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
  setDisplayMenuOpen(!isDisplayMenuOpen());
}

function closeDisplayMenu() {
  setDisplayMenuOpen(false);
}

document.addEventListener('click', (event) => {
  if (!isDisplayMenuOpen()) return;
  const menu = document.getElementById('displayMenu');
  if (menu && event.target && typeof menu.contains === 'function' && menu.contains(event.target)) return;
  closeDisplayMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isDisplayMenuOpen()) {
    closeDisplayMenu();
    const button = document.getElementById('displayMenuBtn');
    if (button && typeof button.focus === 'function') button.focus();
  }
});

window.addEventListener('pageshow', applyTextSize);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') applyTextSize();
});

// Search functionality
function performSearch(event) {
  event.preventDefault();
  const form = event.currentTarget || event.target;
  const input = (form && typeof form.querySelector === 'function' && form.querySelector('input[type="search"]'))
    || document.getElementById('searchInput');
  const searchQuery = input ? input.value.trim() : '';
  if (searchQuery) {
    window.location.href = '/search?q=' + encodeURIComponent(searchQuery);
  }
}

// Collapsible search row under the navbar on narrow screens
function isNavbarSearchOpen() {
  const row = document.getElementById('navbarSearchRow');
  return Boolean(row && !row.hidden);
}

function setNavbarSearchOpen(open) {
  const row = document.getElementById('navbarSearchRow');
  const toggle = document.getElementById('navbarSearchToggle');
  if (!row) return;
  const shouldRestoreFocus = !open && document.activeElement && row.contains(document.activeElement);
  row.hidden = !open;
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    if (typeof closeDisplayMenu === 'function') closeDisplayMenu();
    const input = document.getElementById('searchInputMobile');
    if (input && typeof input.focus === 'function') input.focus();
  } else if (shouldRestoreFocus && toggle && typeof toggle.focus === 'function') {
    toggle.focus();
  }
}

function toggleNavbarSearch() {
  setNavbarSearchOpen(!isNavbarSearchOpen());
}

function closeNavbarSearch() {
  setNavbarSearchOpen(false);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isNavbarSearchOpen()) closeNavbarSearch();
});

// AI Assistant Toggle Functionality
let isCollapsed = false;

function initializeAIAssistant() {
  const isMobile = window.innerWidth <= 767;
  const savedState = localStorage.getItem('aiAssistantCollapsed');

  // Default to collapsed on mobile, expanded on desktop
  if (savedState !== null) {
    isCollapsed = savedState === 'true';
  } else {
    isCollapsed = isMobile;
  }

  if (isCollapsed) {
    document.body.classList.add('ai-collapsed');
    const wrapper = document.getElementById('aiAssistantWrapper');
    if (wrapper) wrapper.classList.add('collapsed');
    updateToggleIcon();
  }

  // Add click handler for mobile header
  if (isMobile) {
    const header = document.getElementById('aiAssistantHeader');
    if (header) {
      header.style.cursor = 'pointer';
      header.onclick = toggleAIAssistant;
    }
  }
}

function toggleAIAssistant() {
  isCollapsed = !isCollapsed;
  const wrapper = document.getElementById('aiAssistantWrapper');

  if (isCollapsed) {
    document.body.classList.add('ai-collapsed');
    if (wrapper) wrapper.classList.add('collapsed');
  } else {
    document.body.classList.remove('ai-collapsed');
    if (wrapper) wrapper.classList.remove('collapsed');
  }

  updateToggleIcon();
  localStorage.setItem('aiAssistantCollapsed', isCollapsed);
}

function updateToggleIcon() {
  const icon = document.getElementById('toggleIcon');
  if (icon) {
    const isMobile = window.innerWidth <= 767;
    if (isMobile) {
      icon.className = isCollapsed ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
    } else {
      icon.className = isCollapsed ? 'fas fa-chevron-left' : 'fas fa-chevron-right';
    }
  }
}

// Handle resize events
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    updateToggleIcon();
  }, 250);
});

// Timer functionality
function updateTimerDuration() {
  const timerAlert = document.querySelector('[data-timer-start]');
  if (!timerAlert) return;

  const startTime = new Date(timerAlert.dataset.timerStart);
  const now = new Date();
  const diff = Math.floor((now - startTime) / 1000);

  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;

  const durationSpan = timerAlert.querySelector('.timer-duration');
  if (durationSpan) {
    if (hours > 0) {
      durationSpan.textContent = `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      durationSpan.textContent = `${minutes}m ${seconds}s`;
    } else {
      durationSpan.textContent = `${seconds}s`;
    }
  }
}

// Task Timer countdown functionality
function updateTaskTimerCountdown() {
  const taskTimerAlert = document.querySelector('[data-timer-total-seconds]');
  if (!taskTimerAlert) return;

  // Don't count down while paused
  if (taskTimerAlert.dataset.timerPaused === 'true') return;

  const startTime = new Date(taskTimerAlert.dataset.timerStart);
  const totalSeconds = parseInt(taskTimerAlert.dataset.timerTotalSeconds);
  const phase = taskTimerAlert.dataset.timerPhase || 'work';
  const now = new Date();
  const elapsed = Math.floor((now - startTime) / 1000);
  const remaining = Math.max(0, totalSeconds - elapsed);

  const countdownSpan = taskTimerAlert.querySelector('.task-timer-countdown');
  if (countdownSpan) {
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    countdownSpan.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    // Auto-advance: just reload — server auto-advances based on elapsed time
    if (remaining === 0) {
      location.reload();
    }
  }
}

// Pomodoro countdown. Its own data attributes, so it never collides with the
// task timer's [data-timer-total-seconds] when both banners are on the page.
function updatePomodoroCountdown() {
  const pomodoroAlert = document.querySelector('[data-pomodoro-total-seconds]');
  if (!pomodoroAlert) return;

  // Don't count down while paused
  if (pomodoroAlert.dataset.pomodoroPaused === 'true') return;

  const startTime = new Date(pomodoroAlert.dataset.pomodoroStart);
  const totalSeconds = parseInt(pomodoroAlert.dataset.pomodoroTotalSeconds);
  const now = new Date();
  const elapsed = Math.floor((now - startTime) / 1000);
  const remaining = Math.max(0, totalSeconds - elapsed);

  const countdownSpan = pomodoroAlert.querySelector('.pomodoro-countdown');
  if (countdownSpan) {
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    countdownSpan.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    // The interval is over; reload to pick up the server's hold state, which
    // is what offers the button to start the next one.
    if (remaining === 0) {
      location.reload();
    }
  }
}

// Collapse/expand functionality for sections
// ── The calm tab ────────────────────────────────────────────────────────────
// Unsplash photographs, grouped by the light in them so the picture matches
// the hour, and rotating by date so a given hour is not the same view every
// day. These are direct CDN links: Unsplash retired source.unsplash.com, and
// its licence allows hotlinking without a key.

const MOMENT_PHOTOS = {
  dawn: [
    '1506905925346-21bda4d32df4',
    '1426604966848-d7adac402bff',
    '1439853949127-fa647821eba0'
  ],
  day: [
    '1441974231531-c6227db76b6e',
    '1501854140801-50d01698950b',
    '1518837695005-2083093ee35b',
    '1433086966358-54859d0ed716',
    '1447752875215-b2761acb3c5d',
    '1465146344425-f00d5f5c8f07',
    '1486870591958-9b9d0d1dda99',
    '1458668383970-8ddd3927deed',
    '1419133203517-f3b3ed0ba2bb'
  ],
  dusk: [
    '1470071459604-3b5ec3a7fe05',
    '1472214103451-9374bd1c798e',
    '1475924156734-496f6cac6ec1',
    '1495616811223-4d98c6e9c869',
    '1472120435266-53107fd0c44a'
  ],
  night: [
    '1419242902214-272b3f66ee7a',
    '1507400492013-162706c8c05e',
    '1531306728370-e2ebd9d7bb99'
  ]
};


// Which light the photograph should be in. Dawn and dusk are deliberately
// narrow: they are the hours when a daylight picture would look wrong.
const MOMENT_BUCKETS = ['dawn', 'day', 'dusk', 'night'];

function momentBucket(hour) {
  if (hour < 5 || hour >= 21) return 'night';
  if (hour < 8) return 'dawn';
  if (hour < 18) return 'day';
  return 'dusk';
}

const MOMENT_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// AP style: the short months are not abbreviated.
const MOMENT_MONTHS = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July',
  'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

function momentGreeting(hour) {
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// A stable number for the day, so the photograph and the quote hold still
// across page loads and move only when the date or the hour does.
function momentDayIndex(now) {
  // UTC timestamps built from the local calendar fields, so a 23- or 25-hour
  // day across a DST change still counts as exactly one day.
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today - Date.UTC(now.getFullYear(), 0, 0)) / 86400000);
}

// The photograph turns over when the day does or when the light does, so this
// is the number the quote follows too: one quote per picture.
function momentSlot(now) {
  return momentDayIndex(now) * MOMENT_BUCKETS.length
    + MOMENT_BUCKETS.indexOf(momentBucket(now.getHours()));
}

function momentPhotoUrl(now) {
  const set = MOMENT_PHOTOS[momentBucket(now.getHours())];
  return 'https://images.unsplash.com/photo-'
    + set[momentDayIndex(now) % set.length]
    + '?auto=format&fit=crop&w=2000&q=80';
}

function paintMomentClock() {
  const clock = document.getElementById('momentClock');
  const greeting = document.getElementById('momentGreeting');
  if (!clock || !greeting) return;

  const now = new Date();
  clock.textContent = (now.getHours() % 12 || 12) + ':' + String(now.getMinutes()).padStart(2, '0');

  const panel = document.getElementById('momentPanel');
  const name = panel ? panel.dataset.name : '';
  greeting.textContent = momentGreeting(now.getHours()) + (name ? ', ' + name : '') + '.';
}

function paintMomentPhoto() {
  const holder = document.getElementById('momentPhoto');
  if (!holder) return;
  const url = momentPhotoUrl(new Date());
  if (holder.dataset.url === url) return;

  // Loaded out of view first, so the panel never shows a half-painted photo
  // and never flashes an empty box if the network is slow or absent.
  const image = new Image();
  image.onload = () => {
    holder.style.backgroundImage = 'url("' + url + '")';
    holder.dataset.url = url;
    holder.classList.add('is-loaded');
  };
  image.src = url;
}

// Today's date, and which stage it is when the stages plugin is on. The whole
// week arrives in data-stages because the markup is cached; the day is picked
// here, where the clock is honest.
function paintMomentDate() {
  const target = document.getElementById('momentDate');
  const panel = document.getElementById('momentPanel');
  if (!target || !panel) return;

  const now = new Date();
  const parts = [
    MOMENT_WEEKDAYS[now.getDay()],
    MOMENT_MONTHS[now.getMonth()] + ' ' + now.getDate()
  ];

  if (panel.dataset.stages) {
    try {
      const stages = JSON.parse(panel.dataset.stages);
      if (Array.isArray(stages) && stages[now.getDay()]) parts.push(stages[now.getDay()]);
    } catch (error) {
      // No stage, then. The date is still worth showing on its own.
    }
  }

  target.textContent = parts.join(' \u2022 ');
}

// The quotes are the user's own, in vault/quotes.md, so they are fetched
// rather than shipped. Keyed on the photograph's slot: a new quote arrives
// with each new picture and not before.
async function paintMomentQuote() {
  const target = document.getElementById('momentQuote');
  if (!target) return;

  const slot = momentSlot(new Date());
  if (target.dataset.slot === String(slot)) return;

  try {
    const response = await fetch('/api/quote?index=' + slot);
    const data = await response.json();
    if (!data.success || !data.count) {
      // No vault/quotes.md, or it is empty. Nothing to say, so say nothing.
      target.textContent = '';
      return;
    }
    target.dataset.slot = String(slot);
    target.textContent = '\u201c' + data.text + '\u201d'
      + (data.author ? ' \u2014 ' + data.author : '');
  } catch (error) {
    // Leave whatever is already up; a quote is not worth an error message.
  }
}

function initializeMoment() {
  const panel = document.getElementById('momentPanel');
  if (!panel) return;

  paintMomentClock();
  paintMomentDate();
  paintMomentPhoto();
  paintMomentQuote();

  // Often enough that the clock is never visibly behind, that the picture
  // changes when the hour crosses into a different light, and that the date
  // turns over at midnight on a page left open overnight.
  setInterval(() => {
    paintMomentClock();
    paintMomentDate();
    paintMomentPhoto();
    paintMomentQuote();
  }, 20000);
}

// Every control inside a timer card reloads the page, so without this a tap on
// Pause would close the card it was in. The memory is deliberately short: it
// only survives the reload that a control press causes, so arriving at the
// page later always finds the timers collapsed, which is the whole point of
// them being one line.
const TIMER_CARD_MEMORY_MS = 10000;

// A card is opened to do one thing. Once the timer is running, or once it has
// been stopped, that thing is done and the card goes back to being one line.
// Pause and skip are not on this list: those are adjustments made with the
// card in hand, and the next press is likely to be in it too.
const COLLAPSING_ACTIONS = new Set(['start', 'next', 'resume', 'stop']);

function initializeTimerCards() {
  for (const card of document.querySelectorAll('.timer-card[data-timer-key]')) {
    const key = 'timer-card:' + card.dataset.timerKey;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (saved && saved.open && Date.now() - saved.at < TIMER_CARD_MEMORY_MS) {
        card.open = true;
      } else {
        sessionStorage.removeItem(key);
      }
    } catch (error) {
      // Private window, or storage is blocked. The card starts collapsed.
    }
    const remember = () => {
      try {
        sessionStorage.setItem(key, JSON.stringify({ open: card.open, at: Date.now() }));
      } catch (error) {
        // It still opens and closes; it just will not survive the reload.
      }
    };
    card.addEventListener('toggle', remember);
    // The expiry should measure time since the action, not since opening.
    card.addEventListener('click', event => {
      const control = event.target.closest('.timer-detail button, .timer-detail a');
      if (!control) return;
      // Collapse first, then remember: the memory records the card as the
      // control left it, so the reload the control causes comes back closed.
      if (COLLAPSING_ACTIONS.has(control.dataset.timerAction)) card.open = false;
      remember();
    });
  }
}

// ── The home page's tabbed card ─────────────────────────────────────────────
// Driven here rather than through MDB's tab plugin, which arrives from a CDN:
// the vault listing lives inside a tab panel, and the page's main content
// should not be one failed script away from being unreachable.

function selectHomeTab(name) {
  document.querySelectorAll('[data-home-tab]').forEach(tab => {
    const selected = tab.dataset.homeTab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    // Roving tabindex: the tablist is one stop, and the arrows move within it.
    tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('[data-home-panel]').forEach(panel => {
    panel.hidden = panel.dataset.homePanel !== name;
  });
}

function moveHomeTab(event) {
  const keys = { ArrowLeft: -1, ArrowRight: 1, Home: 'first', End: 'last' };
  const step = keys[event.key];
  if (step === undefined) return;

  const tabs = Array.from(document.querySelectorAll('[data-home-tab]'));
  if (!tabs.length) return;
  const current = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');

  let next;
  if (step === 'first') next = 0;
  else if (step === 'last') next = tabs.length - 1;
  else next = (current + step + tabs.length) % tabs.length;

  event.preventDefault();
  selectHomeTab(tabs[next].dataset.homeTab);
  tabs[next].focus();
}

function toggleCollapse(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return;

  const chevron = document.getElementById(sectionId.replace('Section', 'Chevron'));
  const isExpanded = section.classList.contains('show');

  if (isExpanded) {
    section.classList.remove('show');
    localStorage.setItem('collapse_' + sectionId, 'collapsed');
    if (chevron) {
      chevron.classList.remove('fa-chevron-up');
      chevron.classList.add('fa-chevron-down');
    }
  } else {
    section.classList.add('show');
    localStorage.setItem('collapse_' + sectionId, 'expanded');
    if (chevron) {
      chevron.classList.remove('fa-chevron-down');
      chevron.classList.add('fa-chevron-up');
    }
  }
}

// Restore collapse states from localStorage
function restoreCollapseStates() {
  document.querySelectorAll('.collapse').forEach(section => {
    const state = localStorage.getItem('collapse_' + section.id);
    const chevron = document.getElementById(section.id.replace('Section', 'Chevron'));

    if (state === 'expanded') {
      section.classList.add('show');
      if (chevron) {
        chevron.classList.remove('fa-chevron-down');
        chevron.classList.add('fa-chevron-up');
      }
    } else if (state === 'collapsed') {
      section.classList.remove('show');
      if (chevron) {
        chevron.classList.remove('fa-chevron-up');
        chevron.classList.add('fa-chevron-down');
      }
    }
  });
}

// Task checkbox toggle
async function toggleTaskCheckbox(checkbox) {
  const taskId = checkbox.dataset.taskId;
  if (!taskId) return;

  const wasChecked = !checkbox.checked; // State before toggle

  try {
    const response = await fetch('/task/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, completed: checkbox.checked })
    });

    if (!response.ok) {
      // Revert on failure
      checkbox.checked = wasChecked;
      console.error('Failed to toggle task');
    }
  } catch (error) {
    checkbox.checked = wasChecked;
    console.error('Error toggling task:', error);
  }
}

// Loading spinner for navigation
function initializeLoadingSpinner() {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;

  // Show loading spinner during same-origin navigation
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (link && link.href && !link.target && !link.href.startsWith('javascript:') && !link.getAttribute('href')?.startsWith('#')) {
      // Only handle same-origin links
      try {
        if (new URL(link.href).origin !== window.location.origin) return;
      } catch { return; }

      overlay.style.display = 'flex';
      // Let the browser navigate normally so DOMContentLoaded fires on the new page
    }
  });

  // Hide the spinner when the page is restored from the back-forward cache
  // (e.g. Safari's bfcache restore on Back navigation). In this case,
  // DOMContentLoaded does not re-fire, so the overlay must be reset here.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      overlay.style.display = 'none';
    }
  });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initializeTheme();
  initializePalettes();
  initializeMoment();
  initializeTimerCards();
  initializeTextSize();
  initializeAIAssistant();
  restoreCollapseStates();
  initializeLoadingSpinner();

  // Start timer updates if there's an active timer
  if (document.querySelector('[data-timer-start]')) {
    updateTimerDuration();
    setInterval(updateTimerDuration, 1000);
  }

  // Start task timer countdown if there's an active task timer
  if (document.querySelector('[data-timer-total-seconds]')) {
    updateTaskTimerCountdown();
    setInterval(updateTaskTimerCountdown, 1000);
  }

  // Start pomodoro countdown if there's an active pomodoro interval
  if (document.querySelector('[data-pomodoro-total-seconds]')) {
    updatePomodoroCountdown();
    setInterval(updatePomodoroCountdown, 1000);
  }

  // Add event listeners for task checkboxes
  document.querySelectorAll('.task-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', () => toggleTaskCheckbox(checkbox));
  });
});

// Utility: Escape HTML for safe display
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Chat: Check version and clear old data if needed (reloads page if cleared)
function checkChatVersion() {
  const CHAT_VERSION = 4;
  const storedVersion = localStorage.getItem('chatVersion');
  if (storedVersion !== String(CHAT_VERSION)) {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('chatHistory_') || key === 'inputHistory') {
        localStorage.removeItem(key);
      }
    });
    localStorage.setItem('chatVersion', String(CHAT_VERSION));
    window.location.reload();
    return true; // Page will reload
  }
  return false;
}

// Utility: Create a marked renderer that opens external links in new tabs
function createExternalLinkRenderer() {
  const renderer = new marked.Renderer();
  const originalLink = renderer.link.bind(renderer);
  renderer.link = function(href, title, text) {
    const isExternal = /^https?:\/\//.test(href);
    let link = originalLink(href, title, text);
    if (isExternal) {
      link = link.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
    }
    return link;
  };
  return renderer;
}

// Utility: Get human-readable time ago string
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  let interval = Math.floor(seconds / 31536000);
  if (interval > 1) return interval + ' years ago';
  if (interval === 1) return '1 year ago';

  interval = Math.floor(seconds / 2592000);
  if (interval > 1) return interval + ' months ago';
  if (interval === 1) return '1 month ago';

  interval = Math.floor(seconds / 86400);
  if (interval > 1) return interval + ' days ago';
  if (interval === 1) return '1 day ago';

  interval = Math.floor(seconds / 3600);
  if (interval > 1) return interval + ' hours ago';
  if (interval === 1) return '1 hour ago';

  interval = Math.floor(seconds / 60);
  if (interval > 1) return interval + ' minutes ago';
  if (interval === 1) return '1 minute ago';

  return 'just now';
}

// Task checkboxes are generated in several places without a <label>; name
// each one from its task text so screen readers announce what it toggles.
function labelTaskCheckboxes(root = document) {
  const selector = 'input[type="checkbox"].task-checkbox:not([aria-label]):not([aria-labelledby])';
  const checkboxes = [...root.querySelectorAll(selector)];
  if (root.matches && root.matches(selector)) checkboxes.push(root);
  checkboxes.forEach(checkbox => {
    const item = checkbox.closest('li') || checkbox.parentElement;
    if (!item) return;
    const clone = item.cloneNode(true);
    clone.querySelectorAll('button, input, ul, ol').forEach(el => el.remove());
    const text = clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 150);
    checkbox.setAttribute('aria-label', text || 'Task');
  });
}

if (typeof document.querySelectorAll === 'function') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => labelTaskCheckboxes());
  } else {
    labelTaskCheckboxes();
  }
}

if (typeof MutationObserver === 'function') {
  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1) labelTaskCheckboxes(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

// Reply forms under each role block in today's diary (plugins/roles/web-reply.js).
// The server adds "-> role:" and saves the reply as the block's last item.
async function sendRoleReply(form) {
  const textarea = form.querySelector('textarea');
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('.role-reply-status');
  if (button.disabled) return;
  const text = textarea.value;
  if (!text.trim()) {
    status.textContent = 'Type a reply first.';
    textarea.focus();
    return;
  }

  button.disabled = true;
  status.textContent = 'Saving…';
  try {
    const response = await fetch(`/roles/reply/${form.dataset.file}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: form.dataset.role, text })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `Save failed (${response.status})`);
    }
    status.textContent = 'Saved.';
    textarea.value = '';
    window.location.reload();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

if (typeof document.addEventListener === 'function') {
  document.addEventListener('submit', event => {
    const form = event.target.closest && event.target.closest('form.role-reply-form');
    if (!form) return;
    event.preventDefault();
    sendRoleReply(form);
  });
  // Cmd/Ctrl+Enter sends; plain Enter makes a new line.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    const form = event.target.closest && event.target.closest('form.role-reply-form');
    if (!form) return;
    event.preventDefault();
    sendRoleReply(form);
  });
}
