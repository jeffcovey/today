/**
 * Common JavaScript for Today web interface
 */

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

    // Auto-advance when timer expires
    if (remaining === 0) {
      if (phase === 'work') {
        // Transition to rest period
        fetch('/api/task-timer/rest', {method: 'POST'}).then(function() { location.reload(); });
      } else {
        // Rest done, advance to next item
        fetch('/api/task-timer/skip', {method: 'POST'}).then(function() { location.reload(); });
      }
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

// Loading spinner for navigation (using fetch to keep page alive)
function initializeLoadingSpinner() {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;

  // Handle link clicks with fetch
  document.addEventListener('click', async (e) => {
    const link = e.target.closest('a');
    if (link && link.href && !link.target && !link.href.startsWith('javascript:') && !link.getAttribute('href')?.startsWith('#')) {
      // Only handle same-origin links
      try {
        if (new URL(link.href).origin !== window.location.origin) return;
      } catch { return; }

      e.preventDefault();
      overlay.style.display = 'flex';

      try {
        const response = await fetch(link.href);
        const html = await response.text();

        // Replace the entire document
        document.open();
        document.write(html);
        document.close();

        // Update URL
        history.pushState(null, '', link.href);
      } catch (err) {
        overlay.style.display = 'none';
        // Fallback to normal navigation on error
        window.location.href = link.href;
      }
    }
  });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
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
