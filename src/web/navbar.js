function escapeSearchValue(value) {
  return String(value).replace(/"/g, '&quot;');
}

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
})();
</script>`;
}

export function getThemeToggleButtonHtml() {
  return `<button class="btn btn-light btn-sm ms-auto" type="button" id="themeToggleBtn" onclick="cycleThemeMode()" title="Theme" aria-label="Toggle theme mode">
            <i class="fas fa-circle-half-stroke" id="themeToggleIcon"></i>
          </button>`;
}

export function getNavbar(title = 'Today', icon = 'fa-folder-open', options = {}) {
  const { showSearch = true, searchValue = '' } = options;
  const searchForm = showSearch ? `
          <form class="d-flex ms-2" onsubmit="performSearch(event)">
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
          <a class="nav-link text-light px-2" href="/_git" title="Git Changes">
            <i class="fas fa-code-branch"></i>
          </a>
          ${searchForm}
        </div>
      </nav>`;
}
