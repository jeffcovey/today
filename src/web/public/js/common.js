/**
 * Common JavaScript for Today web interface
 */

// Theme functionality
const THEME_STORAGE_KEY = 'todayThemeMode';
let themeMediaQuery = null;

function getThemeMode() {
  const mode = localStorage.getItem(THEME_STORAGE_KEY);
  return mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system';
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

function applyTheme(mode = getThemeMode()) {
  const effectiveTheme = getEffectiveTheme(mode);
  document.documentElement.setAttribute('data-theme', effectiveTheme);
  updateThemeToggle(mode, effectiveTheme);
}

function getNextThemeMode(mode) {
  if (mode === 'system') return 'dark';
  if (mode === 'dark') return 'light';
  return 'system';
}

function setThemeMode(mode) {
  const next = mode === 'dark' || mode === 'light' ? mode : 'system';
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next);
}

function cycleThemeMode() {
  setThemeMode(getNextThemeMode(getThemeMode()));
}

function initializeTheme() {
  const mode = getThemeMode();
  const effectiveTheme = getEffectiveTheme(mode);
  if (!document.documentElement.dataset.theme) {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
  }
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
  row.hidden = !open;
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    if (typeof closeDisplayMenu === 'function') closeDisplayMenu();
    const input = document.getElementById('searchInputMobile');
    if (input && typeof input.focus === 'function') input.focus();
  } else if (toggle && typeof toggle.focus === 'function' && document.activeElement &&
             document.activeElement.id === 'searchInputMobile') {
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

// Collapse/expand functionality for sections
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
