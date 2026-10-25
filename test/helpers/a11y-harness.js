/**
 * Shared harness for the web accessibility audit: starts the real web server
 * against a copy of a fixture vault, then drives headless Chrome to render
 * pages in each theme and run axe-core on them.
 */

import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDailyPlanRelativePath } from '../../src/plan-utils.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const FIXTURE_VAULT = path.join(PROJECT_ROOT, 'test', 'fixtures', 'a11y-vault');
export const PASSWORD = 'a11y-test-password';

export const THEMES = ['light', 'dark'];
export const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  desktop: { width: 1280, height: 900, deviceScaleFactor: 1 }
};

// Today's daily plan gets the role reply forms; its role blocks are copied
// from the fixture diary.
export const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export const TODAY_PLAN_PATH = `/${getDailyPlanRelativePath(TODAY)}`;

export const PAGES = [
  { name: 'home', path: '/' },
  { name: 'diary', path: '/diary/2026-01-15.md' },
  { name: 'plan-today', path: TODAY_PLAN_PATH },
  { name: 'kitchen-sink', path: '/notes/kitchen-sink.md' },
  { name: 'toml', path: '/notes/settings.toml' },
  { name: 'project', path: '/projects/sample-project.md' },
  { name: 'directory', path: '/notes/' },
  { name: 'login', path: '/auth/login', public: true },
  { name: 'git-markdown', path: '/_git', openDiff: 'notes/kitchen-sink.md' },
  { name: 'git-javascript', path: '/_git', openDiff: 'code/example.js' }
];

/**
 * Make the vault copy a git repository with uncommitted edits, so the /_git
 * page has diffs to show: Markdown and JavaScript, for both highlighters.
 */
function initVaultRepo(vaultDir) {
  // Lefthook and other hooks export GIT_* variables that would point these
  // commands at the project's own repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', args, { cwd: vaultDir, env, stdio: 'pipe' });
  git('init', '--quiet');
  git('config', 'user.email', 'a11y@example.com');
  git('config', 'user.name', 'Accessibility Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '--quiet', '--no-verify', '-m', 'Fixture vault');

  const notePath = path.join(vaultDir, 'notes', 'kitchen-sink.md');
  fs.writeFileSync(notePath, fs.readFileSync(notePath, 'utf8')
    .replace('- Bullet two', '- Bullet two, edited with a [new link](https://example.com)')
    .replace('## Footnote', '## Footnote, renamed'));

  // Staged, so its diff shows the staged-file actions (Unstage).
  git('add', 'notes/kitchen-sink.md');

  // A second edit in code/, so the git page groups the directory under a header.
  const helperPath = path.join(vaultDir, 'code', 'helper.js');
  fs.writeFileSync(helperPath, fs.readFileSync(helperPath, 'utf8').replace("'helper'", "'helper, edited'"));

  const codePath = path.join(vaultDir, 'code', 'example.js');
  fs.writeFileSync(codePath, fs.readFileSync(codePath, 'utf8')
    .replace("const greeting = 'hello';", "const greeting = 'hello there';\nconst answer = 42;")
    .replace('return `${greeting}, ${name}`;', 'return `${greeting}, ${name}! The answer is ${answer}.`;'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start the web server on a free port against a temporary copy of the
 * fixture vault. Returns { baseUrl, vaultDir, workDir, stop, output }.
 *
 * Pass `workDir` (a directory an earlier call returned, started with
 * `keepWorkDir`) to start a second server over the first one's vault, config
 * and .data -- which is how a restart is tested. The new server gets a new
 * port; everything on disk is left exactly as the first one left it.
 */
export async function startServer({
  vaultSource = FIXTURE_VAULT,
  timeoutMs = 60_000,
  configLines = [],
  workDir: existingWorkDir = null,
  keepWorkDir = false
} = {}) {
  const workDir = existingWorkDir || fs.mkdtempSync(path.join(os.tmpdir(), 'today-a11y-'));
  const vaultDir = path.join(workDir, 'vault');
  const configPath = path.join(workDir, 'config.toml');
  if (existingWorkDir) {
    // The config and the vault are whatever the first server left behind, so
    // say so rather than quietly dropping a caller's settings.
    if (configLines.length > 0 || vaultSource !== FIXTURE_VAULT) {
      throw new Error('startServer: configLines and vaultSource apply only to a fresh workDir');
    }
  } else {
    await prepareWorkDir({ workDir, vaultDir, configPath, vaultSource, configLines });
  }

  return launchServer({ workDir, vaultDir, configPath, timeoutMs, keepWorkDir });
}

async function prepareWorkDir({ workDir, vaultDir, configPath, vaultSource, configLines }) {
  fs.cpSync(vaultSource, vaultDir, { recursive: true });
  const fixtureDiary = path.join(vaultDir, 'diary', '2026-01-15.md');
  if (fs.existsSync(fixtureDiary)) {
    const todayPlan = path.join(vaultDir, TODAY_PLAN_PATH);
    fs.mkdirSync(path.dirname(todayPlan), { recursive: true });
    fs.writeFileSync(todayPlan,
      fs.readFileSync(fixtureDiary, 'utf8').replace(/^date: .*$/m, `date: ${TODAY}`));
  }
  // A running timer, so the timer banner is audited too.
  const timerDir = path.join(vaultDir, 'logs', 'time-tracking');
  fs.mkdirSync(timerDir, { recursive: true });
  fs.writeFileSync(path.join(timerDir, 'current-timer.md'),
    `Write the accessibility tests #topic/sample\n${new Date(Date.now() - 25 * 60_000).toISOString()}\n`);
  initVaultRepo(vaultDir);

  // The server resolves vault_path against the project root, so it must be
  // relative even though the vault lives in a temp directory.
  fs.writeFileSync(configPath, [
    `vault_path = ${JSON.stringify(path.relative(PROJECT_ROOT, vaultDir))}`,
    'timezone = "America/New_York"',
    '',
    '[profile]',
    'name = "Sam"',
    'timezone = "America/New_York"',
    '',
    '[plugins.roles.default]',
    'enabled = true',
    '',
    // Switched on so the pomodoro banner is audited alongside everything else.
    '[pomodoro]',
    'enabled = true',
    'work_periods = 2',
    'work_minutes = 25',
    'short_rest_minutes = 5',
    'long_rest_minutes = 15',
    '',
    ...configLines
  ].join('\n'));

  // The server reads .data/today.db relative to its working directory and
  // expects the schema to exist.
  fs.mkdirSync(path.join(workDir, '.data'), { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const { MigrationManager } = await import('../../src/migrations.js');
  const db = new Database(path.join(workDir, '.data', 'today.db'));
  try {
    await new MigrationManager(db, { verbose: false }).runMigrations();
    // Tasks due today and overdue switch on the task widgets and lists, which
    // are styled differently from an empty task list.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const insert = db.prepare(
      'INSERT INTO tasks (id, source, title, status, priority, due_date, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insert.run('markdown-tasks/local:vault/notes/kitchen-sink.md:59', 'markdown-tasks/local',
      'Open task due today', 'open', 'highest', today,
      JSON.stringify({ file_path: 'vault/notes/kitchen-sink.md', line_number: 59, tags: ['topic/sample'] }));
    insert.run('markdown-tasks/local:vault/projects/sample-project.md:21', 'markdown-tasks/local',
      'Overdue objective', 'open', 'medium', '2026-01-10',
      JSON.stringify({ file_path: 'vault/projects/sample-project.md', line_number: 21, stage: 'back-stage' }));
  } finally {
    db.close();
  }
}

async function launchServer({ workDir, vaultDir, configPath, timeoutMs, keepWorkDir }) {
  const port = await freePort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('DOTENV') || key === 'WEB_PASSWORD' || key === 'WEB_USER') {
      delete env[key];
    }
  }
  Object.assign(env, {
    TODAY_CONFIG: configPath,
    // Kept inside the temp directory: the default sits beside the source, so
    // runs would otherwise inherit each other's theme — and a run in a live
    // checkout would overwrite the real one.
    TODAY_WEB_PREFERENCES: path.join(workDir, 'web-preferences.json'),
    // Kept inside the temp directory for the same reason, and so a restart
    // test can restore from the state the first server wrote.
    TODAY_TIMER_STATE: path.join(workDir, 'timer-state.json'),
    WEB_PORT: String(port),
    WEB_PASSWORD: PASSWORD,
    NODE_ENV: 'test',
    TZ: 'America/New_York'
  });

  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'web-server.js')], {
    cwd: workDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      break;
    }
    try {
      const res = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
      if (res.status < 500) {
        ready = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const stop = async () => {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
          resolve();
        }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (!keepWorkDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  };

  if (!ready) {
    await stop();
    throw new Error(`Web server did not start within ${timeoutMs}ms:\n${output.slice(-3000)}`);
  }

  return { baseUrl, vaultDir, workDir, stop, output: () => output };
}

export function axeSource() {
  return fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
}

async function gotoAndVerifyAssets(page, url) {
  const failedAssets = new Set();
  const trackAsset = (request) => {
    if (['stylesheet', 'script'].includes(request.resourceType())) {
      failedAssets.add(request.url());
    }
  };
  page.on('requestfailed', trackAsset);
  page.on('response', (response) => {
    if (response.status() >= 400) {
      trackAsset(response.request());
    }
  });

  const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
  if (failedAssets.size > 0) {
    throw new Error(`Failed stylesheet or script requests: ${[...failedAssets].join(', ')}`);
  }

  const unattachedStylesheets = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="stylesheet"]')]
      .filter(link => !link.sheet)
      .map(link => link.href || link.outerHTML)
  );
  if (unattachedStylesheets.length > 0) {
    throw new Error(`Stylesheets did not load: ${unattachedStylesheets.join(', ')}`);
  }
  return response;
}

/**
 * Set the shared preference and browser colour scheme before loading a page.
 */
export async function useTheme(page, theme, baseUrl) {
  const response = await fetch(`${baseUrl}/api/theme`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + PASSWORD,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ mode: theme })
  });
  if (!response.ok) {
    throw new Error(`Could not set fixture theme: ${response.status}`);
  }
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.evaluateOnNewDocument((mode) => {
    try { localStorage.setItem('todayThemeMode', mode); } catch { /* storage blocked */ }
  }, theme);
}

/**
 * Choose a palette. Unlike the mode, this one is purely server-side: the
 * colours arrive as /theme.css, so there is nothing to set in the browser.
 */
export async function usePalette(name, baseUrl) {
  const response = await fetch(`${baseUrl}/api/theme`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + PASSWORD,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name })
  });
  if (!response.ok) {
    throw new Error(`Could not set fixture palette: ${response.status}`);
  }
}

/**
 * Load a page in the given theme and viewport and run axe on it twice: as
 * rendered (collapsed toggles closed), then with every <details> opened so
 * hidden content is checked too. Returns a list of violations, each tagged
 * with the state it was found in.
 */
export async function auditPage(browser, { baseUrl, page: pageSpec, theme, viewport, rules }) {
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORTS[viewport]);
    await useTheme(page, theme, baseUrl);
    if (!pageSpec.public) {
      await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
    }

    const response = await gotoAndVerifyAssets(page, baseUrl + pageSpec.path);
    if (!response || response.status() >= 400) {
      throw new Error(`${pageSpec.path} returned ${response ? response.status() : 'no response'}`);
    }

    // MDB and Bootstrap switch their own components on their own attributes, so
    // all three have to agree or half the page stays in the other theme.
    const applied = await page.evaluate(() => {
      const { theme, mdbTheme, bsTheme } = document.documentElement.dataset;
      return { 'data-theme': theme, 'data-mdb-theme': mdbTheme, 'data-bs-theme': bsTheme };
    });
    for (const [attribute, value] of Object.entries(applied)) {
      if (value !== theme) {
        throw new Error(`${pageSpec.path}: expected ${attribute}="${theme}", got "${value}"`);
      }
    }

    if (pageSpec.openDiff) {
      await openDiff(page, pageSpec.openDiff);
    }

    // Measure final colours: a background mid-transition (a just-selected
    // item fading in) would otherwise fail or pass depending on timing.
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    await page.addScriptTag({ content: axeSource() });
    const runAxe = () => page.evaluate(async (ruleIds) => {
      const options = ruleIds
        ? { runOnly: { type: 'rule', values: ruleIds } }
        : { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } };
      const result = await window.axe.run(document, options);
      const describe = (v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map(n => ({ target: n.target.join(' '), summary: n.failureSummary, html: n.html.slice(0, 200) }))
      });

      // axe files short strings — a count badge, a single-letter label — under
      // `incomplete` rather than `violations`, because it can't tell real text
      // from decoration. It has measured the contrast all the same, so judge
      // those itself: anything holding a letter or digit is real text. Other
      // incomplete reasons (background image, overlapping element) stay out,
      // since those really are undeterminable and would fail at random.
      const shortText = result.incomplete
        .filter(v => v.id === 'color-contrast')
        .map(v => ({
          ...describe(v),
          nodes: v.nodes.filter((n) => {
            const data = n.any.find(a => a.data?.messageKey === 'shortTextContent')?.data;
            // axe only hands back a DOM reference when asked, so read the text
            // off the page, falling back to the markup it reports when the
            // target names a frame or isn't a selector this document accepts.
            let node = null;
            try {
              node = typeof n.target[0] === 'string' ? document.querySelector(n.target[0]) : null;
            } catch {
              node = null;
            }
            const text = node ? node.textContent : n.html.replace(/<[^>]*>/g, '');
            if (!data || !/[\p{L}\p{N}]/u.test(text)) return false;
            const expected = parseFloat(data.expectedContrastRatio);
            return Number.isFinite(expected) && data.contrastRatio < expected;
          }).map((n) => {
            const data = n.any.find(a => a.data?.messageKey === 'shortTextContent').data;
            return {
              target: n.target.join(' '),
              summary: `Fix any of the following:\n  Element has insufficient colour contrast of ` +
                `${data.contrastRatio} (foreground ${data.fgColor}, background ${data.bgColor}), ` +
                `expected ${data.expectedContrastRatio}`,
              html: n.html.slice(0, 200)
            };
          })
        }))
        .filter(v => v.nodes.length > 0);

      return [...result.violations.map(describe), ...shortText];
    }, rules || null);

    const collapsed = await runAxe();
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach(d => { d.open = true; });
      document.querySelectorAll('.collapse').forEach(el => el.classList.add('show'));
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    const expanded = await runAxe();

    const seen = new Set();
    const violations = [];
    for (const [state, list] of [['collapsed', collapsed], ['expanded', expanded]]) {
      for (const v of list) {
        for (const node of v.nodes) {
          const key = `${v.id}|${node.target}`;
          if (seen.has(key)) continue;
          seen.add(key);
          violations.push({ rule: v.id, impact: v.impact, help: v.help, state, ...node });
        }
      }
    }
    return violations;
  } finally {
    await page.close();
  }
}

/**
 * Scroll partway down a page and report every pair of pinned (sticky or
 * fixed) elements that overlap on screen, such as a breadcrumb landing on
 * top of a sticky card header. Nested pairs don't count.
 */
export async function findPinnedOverlaps(browser, { baseUrl, page: pageSpec, theme, viewport, scrollY = 900 }) {
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORTS[viewport]);
    await useTheme(page, theme, baseUrl);
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${PASSWORD}` });
    await gotoAndVerifyAssets(page, baseUrl + pageSpec.path);
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await new Promise(resolve => setTimeout(resolve, 300));

    return await page.evaluate(() => {
      const describe = el => el.tagName.toLowerCase() +
        (el.id ? `#${el.id}` : '') +
        (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      // A sticky element counts only while it is actually stuck at its offset;
      // one scrolling away with its container may pass under the navbar.
      const pinned = [...document.querySelectorAll('body *')].filter(el => {
        const style = getComputedStyle(el);
        if (style.position !== 'sticky' && style.position !== 'fixed') return false;
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight)) return false;
        if (style.position === 'fixed') return true;
        const top = parseFloat(style.top);
        return Number.isFinite(top) && Math.abs(r.top - top) <= 1;
      });
      const overlaps = [];
      for (let i = 0; i < pinned.length; i++) {
        for (let j = i + 1; j < pinned.length; j++) {
          const a = pinned[i];
          const b = pinned[j];
          if (a.contains(b) || b.contains(a)) continue;
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (x > 1 && y > 1) {
            overlaps.push(`${describe(a)} overlaps ${describe(b)} by ${Math.round(x)}x${Math.round(y)}px`);
          }
        }
      }
      return overlaps;
    });
  } finally {
    await page.close();
  }
}

/**
 * On the /_git page, click a changed file and wait until its diff is drawn
 * and syntax-highlighted.
 */
export async function openDiff(page, file) {
  const selector = `.file-item[data-file="${file}"]`;
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.$eval(selector, el => el.click());
  await page.waitForSelector('#diffContent .d2h-wrapper .hljs', { timeout: 15_000 });
}
