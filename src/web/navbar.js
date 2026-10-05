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

export function getTextSizeControlHtml() {
  return `<div class="btn-group btn-group-sm ms-1 text-size-control" role="group" aria-label="Text size">
            <button class="btn btn-light btn-sm" type="button" id="textSizeDownBtn" onclick="adjustTextSize(-1)" title="Smaller text" aria-label="Smaller text">
              <i class="fas fa-minus"></i>
            </button>
            <span class="btn btn-light btn-sm pe-none" id="textSizeLabel" title="Text size: Large" aria-live="polite">
              <i class="fas fa-font" aria-hidden="true"></i><span class="visually-hidden" id="textSizeAnnouncement">Text size: Large (system)</span>
            </span>
            <button class="btn btn-light btn-sm" type="button" id="textSizeUpBtn" onclick="adjustTextSize(1)" title="Larger text" aria-label="Larger text">
              <i class="fas fa-plus"></i>
            </button>
          </div>`;
}

export function getThemeToggleButtonHtml() {
  return `<button class="btn btn-light btn-sm ms-auto" type="button" id="themeToggleBtn" onclick="cycleThemeMode()" title="Theme" aria-label="Toggle theme mode">
            <i class="fas fa-circle-half-stroke" id="themeToggleIcon"></i>
          </button>`;
}

export function getNavbar(title = 'Today', icon = 'fa-folder-open', options = {}) {
  const { showSearch = true, searchValue = '' } = options;
  const searchForm = showSearch ? `
          <form class="d-flex" onsubmit="performSearch(event)">
            <div class="input-group">
              <input class="form-control form-control-sm" type="search" placeholder="Search vault..." aria-label="Search" id="searchInput"${searchValue ? ` value="${escapeSearchValue(searchValue)}"` : ''} style="max-width: 250px;">
              <button class="btn btn-light btn-sm" type="submit">
                <i class="fas fa-search"></i>
              </button>
            </div>
          </form>` : '';

  return `<!-- Loading Spinner Overlay -->
      <div id="loadingOverlay" class="loading-overlay">
        <div class="loading-spinner"></div>
      </div>
      <!-- Navbar -->
      <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container-fluid">
          <a class="navbar-brand" href="/">
            <i class="fas ${icon} me-2"></i>${title}
          </a>
          ${getThemeToggleButtonHtml()}
          ${getTextSizeControlHtml()}
          <a class="nav-link text-light px-2" href="/_summaries" title="Plan Summaries">
            <i class="fas fa-pen-to-square"></i>
          </a>
          <a class="nav-link text-light px-2" href="/_git" title="Git Changes">
            <i class="fas fa-code-branch"></i>
          </a>
          ${showSearch ? `<div class="ms-2">${searchForm}</div>` : ''}
        </div>
      </nav>`;
}
