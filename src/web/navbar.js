function escapeSearchValue(value) {
  return String(value).replace(/"/g, '&quot;');
}

// iOS Dynamic Type body sizes (UIFontTextStyleBody), in CSS px. The index of
// 'Large' (17px) is the iOS default. Safari exposes the user's current setting
// through the `font: -apple-system-body` keyword; other browsers fall back to
// the iOS default so every device shares the same scale.
export const TEXT_SIZES = [14, 15, 16, 17, 19, 21, 23, 28, 33, 40, 47, 53];
export const TEXT_SIZE_NAMES = [
  'Extra Small', 'Small', 'Medium', 'Large', 'Extra Large', 'XX Large', 'XXX Large',
  'AX1', 'AX2', 'AX3', 'AX4', 'AX5',
];
export const DEFAULT_TEXT_SIZE_INDEX = 3;
export const TEXT_SIZE_STORAGE_KEY = 'todayTextSizeOffset';

export function getThemeBootstrapScript() {
  return `<script>
(() => {
  try {
    const mode = localStorage.getItem('todayThemeMode') || 'system';
    const prefersDark = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = mode === 'dark' || mode === 'light'
      ? mode
      : (prefersDark ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
  } catch {
    // Ignore storage/matchMedia failures
  }
  // Apply text size before first paint (full logic lives in common.js)
  try {
    const sizes = ${JSON.stringify(TEXT_SIZES)};
    let systemIndex = ${DEFAULT_TEXT_SIZE_INDEX};
    const isIOS = typeof navigator !== 'undefined' &&
      (/iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
    const getSystemIndex = () => {
      let index = ${DEFAULT_TEXT_SIZE_INDEX};
      if (!isIOS || typeof CSS === 'undefined' || !CSS.supports ||
          !CSS.supports('font', '-apple-system-body')) return index;
      const probe = document.createElement('div');
      probe.style.font = '-apple-system-body';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      document.documentElement.appendChild(probe);
      const px = parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      if (px > 0) {
        index = sizes.reduce((best, size, i) =>
          Math.abs(size - px) < Math.abs(sizes[best] - px) ? i : best, 0);
      }
      return index;
    };
    const applyTextSize = () => {
      systemIndex = getSystemIndex();
      const offset = parseInt(localStorage.getItem('${TEXT_SIZE_STORAGE_KEY}') || '0', 10) || 0;
      const index = Math.min(sizes.length - 1, Math.max(0, systemIndex + offset));
      const zoom = parseFloat(document.documentElement.dataset.zoom) || 100;
      document.documentElement.style.fontSize = (sizes[index] * zoom / 100) + 'px';
    };
    applyTextSize();
    window.addEventListener('pageshow', applyTextSize);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') applyTextSize();
    });
  } catch {
    // Ignore failures; CSS fallback applies
  }
})();
</script>`;
}

// Display settings menu: theme (light / system / dark) and text size live
// behind one gear button so the navbar stays uncluttered on phones.
export function getDisplayMenuHtml() {
  return `<div class="display-menu" id="displayMenu">
            <button class="nav-link navbar-icon-btn px-2" type="button" id="displayMenuBtn" onclick="toggleDisplayMenu(event)" title="Display settings" aria-label="Display settings" aria-expanded="false" aria-controls="displayMenuPanel">
              <i class="fas fa-gear" aria-hidden="true"></i>
            </button>
            <div class="dropdown-menu display-menu-panel" id="displayMenuPanel" role="group" aria-label="Display settings" aria-labelledby="displayMenuBtn">
              <div class="display-menu-row">
                <span class="display-menu-label">Theme</span>
                <div class="btn-group btn-group-sm theme-mode-group" role="group" aria-label="Theme">
                  <button type="button" class="btn btn-outline-secondary" data-theme-mode="light" onclick="setThemeMode('light')" aria-pressed="false"><i class="fas fa-sun me-1" aria-hidden="true"></i>Light</button>
                  <button type="button" class="btn btn-outline-secondary" data-theme-mode="system" onclick="setThemeMode('system')" aria-pressed="false"><i class="fas fa-circle-half-stroke me-1" aria-hidden="true"></i>System</button>
                  <button type="button" class="btn btn-outline-secondary" data-theme-mode="dark" onclick="setThemeMode('dark')" aria-pressed="false"><i class="fas fa-moon me-1" aria-hidden="true"></i>Dark</button>
                </div>
              </div>
              <div class="display-menu-row">
                <span class="display-menu-label">Text size</span>
                <div class="display-menu-controls">
                  <span class="display-menu-value" id="textSizeLabel" aria-live="polite" title="Text size: Large (system)">Large</span>
                  <div class="btn-group btn-group-sm text-size-control" role="group" aria-label="Text size">
                    <button class="btn btn-outline-secondary" type="button" id="textSizeDownBtn" onclick="adjustTextSize(-1)" title="Smaller text" aria-label="Smaller text">
                      <i class="fas fa-minus" aria-hidden="true"></i>
                    </button>
                    <button class="btn btn-outline-secondary" type="button" id="textSizeUpBtn" onclick="adjustTextSize(1)" title="Larger text" aria-label="Larger text">
                      <i class="fas fa-plus" aria-hidden="true"></i>
                    </button>
                  </div>
                </div>
              </div>
              <div class="display-menu-row display-menu-foot">
                <span class="display-menu-hint" id="textSizeHint">Matches your device setting</span>
                <button type="button" class="btn btn-link btn-sm p-0 display-menu-reset" id="textSizeResetBtn" onclick="resetTextSize()" aria-label="Reset text size to device setting" title="Reset text size to device setting" disabled>Reset</button>
              </div>
            </div>
          </div>`;
}

function searchValueAttr(searchValue) {
  return searchValue ? ` value="${escapeSearchValue(searchValue)}"` : '';
}

// Inline search field, shown from the md breakpoint up where there is room.
export function getSearchFormHtml(searchValue = '') {
  return `<form class="d-none d-md-flex ms-2 navbar-search-inline" onsubmit="performSearch(event)">
            <div class="input-group">
              <input class="form-control form-control-sm" type="search" placeholder="Search vault..." aria-label="Search" id="searchInput"${searchValueAttr(searchValue)} style="max-width: 250px;">
              <button class="btn btn-light btn-sm" type="submit" aria-label="Search">
                <i class="fas fa-search" aria-hidden="true"></i>
              </button>
            </div>
          </form>`;
}

// Magnifier icon for narrow screens; opens a full-width field under the bar.
export function getSearchToggleHtml() {
  return `<button class="nav-link navbar-icon-btn px-2 d-md-none" type="button" id="navbarSearchToggle" onclick="toggleNavbarSearch()" title="Search" aria-label="Search" aria-expanded="false" aria-controls="navbarSearchRow">
            <i class="fas fa-search" aria-hidden="true"></i>
          </button>`;
}

export function getSearchRowHtml(searchValue = '') {
  return `<div class="navbar-search-row w-100 d-md-none" id="navbarSearchRow" hidden>
          <form onsubmit="performSearch(event)">
            <input class="form-control" type="search" placeholder="Search vault..." aria-label="Search" id="searchInputMobile"${searchValueAttr(searchValue)}>
            <button class="btn btn-link navbar-search-cancel" type="button" onclick="closeNavbarSearch()">Cancel</button>
          </form>
        </div>`;
}

export function getNavbar(title = 'Today', icon = 'fa-folder-open', options = {}) {
  const { showSearch = true, searchValue = '' } = options;

  return `<!-- Loading Spinner Overlay -->
      <div id="loadingOverlay" class="loading-overlay">
        <div class="loading-spinner"></div>
      </div>
      <!-- Navbar -->
      <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container-fluid has-display-menu">
          <a class="navbar-brand" href="/" title="${title}">
            <i class="fas ${icon}" aria-hidden="true"></i><span class="navbar-brand-text d-none d-sm-inline ms-2">${title}</span>
          </a>
          ${getDisplayMenuHtml()}
          <a class="nav-link navbar-icon-link px-2 ms-auto" href="/_summaries" title="Plan Summaries" aria-label="Plan Summaries">
            <i class="fas fa-pen-to-square" aria-hidden="true"></i>
          </a>
          <a class="nav-link navbar-icon-link px-2" href="/_git" title="Git Changes" aria-label="Git Changes">
            <i class="fas fa-code-branch" aria-hidden="true"></i>
          </a>
          ${showSearch ? getSearchToggleHtml() : ''}
          ${showSearch ? getSearchFormHtml(searchValue) : ''}
        </div>
        ${showSearch ? getSearchRowHtml(searchValue) : ''}
      </nav>`;
}
