/**
 * Common JavaScript for Today web interface
 */

// Theme functionality
const THEME_STORAGE_KEY = 'todayThemeMode';
let themeMediaQuery = null;

function getThemeMode() {
  return localStorage.getItem(THEME_STORAGE_KEY) || 'system';
}

function getEffectiveTheme(mode) {
  if (mode === 'dark' || mode === 'light') {
    return mode;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeToggle(mode, effectiveTheme) {
  const toggle = document.getElementById('themeToggleBtn');
  const icon = document.getElementById('themeToggleIcon');
  if (!toggle || !icon) return;

  if (mode === 'system') {
    icon.className = 'fas fa-circle-half-stroke';
    toggle.title = `Theme: System (${effectiveTheme})`;
    return;
  }

  if (mode === 'dark') {
    icon.className = 'fas fa-moon';
    toggle.title = 'Theme: Dark';
    return;
  }

  icon.className = 'fas fa-sun';
  toggle.title = 'Theme: Light';
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

function cycleThemeMode() {
  const current = getThemeMode();
  const next = getNextThemeMode(current);
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next);
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

// Search functionality
function performSearch(event) {
  event.preventDefault();
  const searchQuery = document.getElementById('searchInput').value.trim();
  if (searchQuery) {
    window.location.href = '/search?q=' + encodeURIComponent(searchQuery);
  }
}

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
  if (section) {
    if (section.classList.contains('show')) {
      section.classList.remove('show');
      localStorage.setItem('collapse_' + sectionId, 'collapsed');
    } else {
      section.classList.add('show');
      localStorage.setItem('collapse_' + sectionId, 'expanded');
    }
  }
}

// Restore collapse states from localStorage
function restoreCollapseStates() {
  document.querySelectorAll('.collapse').forEach(section => {
    const state = localStorage.getItem('collapse_' + section.id);
    if (state === 'expanded') {
      section.classList.add('show');
    } else if (state === 'collapsed') {
      section.classList.remove('show');
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
