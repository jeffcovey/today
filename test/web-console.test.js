/**
 * The web console: a shell on the server behind the web view's login, with
 * the Today checkout as its working directory. Off unless config switches it
 * on; the WebSocket upgrade is refused without a session.
 */

import { jest } from '@jest/globals';
import WebSocket from 'ws';
import { startServer, PASSWORD, PROJECT_ROOT } from './helpers/a11y-harness.js';
import {
  getConsoleConfig, shellEnvironment, DEFAULT_IDLE_MINUTES, CLOSE_IDLE, CLOSE_SHELL_EXITED
} from '../src/web-console.js';

jest.setTimeout(180_000);

describe('getConsoleConfig', () => {
  test('is off without a section', () => {
    expect(getConsoleConfig(undefined).enabled).toBe(false);
    expect(getConsoleConfig(null).enabled).toBe(false);
    expect(getConsoleConfig(null).idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
  });

  test('needs enabled = true exactly', () => {
    expect(getConsoleConfig({ enabled: 'yes' }).enabled).toBe(false);
    expect(getConsoleConfig({ enabled: 1 }).enabled).toBe(false);
    expect(getConsoleConfig({ enabled: true }).enabled).toBe(true);
  });

  test('idle_minutes survives junk, allows zero for never, and fractions', () => {
    expect(getConsoleConfig({ idle_minutes: 'soon' }).idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
    expect(getConsoleConfig({ idle_minutes: -5 }).idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
    expect(getConsoleConfig({ idle_minutes: 100_000 }).idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
    expect(getConsoleConfig({ idle_minutes: 0 }).idleMinutes).toBe(0);
    expect(getConsoleConfig({ idle_minutes: 0.05 }).idleMinutes).toBe(0.05);
    expect(getConsoleConfig({ idle_minutes: '45' }).idleMinutes).toBe(45);
  });

  test('the shell defaults to one that exists and accepts an override', () => {
    expect(getConsoleConfig({}).shell).toMatch(/sh$/);
    expect(getConsoleConfig({ shell: ' /bin/sh ' }).shell).toBe('/bin/sh');
    expect(getConsoleConfig({ shell: '   ' }).shell).toMatch(/sh$/);
  });
});

describe('shellEnvironment', () => {
  test('drops the dotenvx markers and names the terminal', () => {
    const env = shellEnvironment({ PATH: '/bin', HOME: '/root', DOTENVX_RUNNING: '1', DOTENV_KEY: 'k', LANG: 'en_US.UTF-8' });
    expect(env).toEqual({
      PATH: '/bin', HOME: '/root', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor'
    });
  });

  test('supplies a UTF-8 locale when there is none', () => {
    expect(shellEnvironment({}).LANG).toBe('C.UTF-8');
  });
});

const socketUrl = (baseUrl) => baseUrl.replace(/^http/, 'ws') + '/_console/socket';
const authHeaders = { Authorization: `Bearer ${PASSWORD}` };

function openSocket(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`unexpected status ${res.statusCode}`)));
  });
}

function collect(ws) {
  const state = { text: '', hello: null, exitCode: null, closeCode: null };
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'output') state.text += message.data;
    else if (message.type === 'hello') state.hello = message;
    else if (message.type === 'exit') state.exitCode = message.code;
  });
  ws.on('close', (code) => { state.closeCode = code; });
  return state;
}

async function waitFor(check, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const input = (ws, data) => ws.send(JSON.stringify({ type: 'input', data }));

describe('with [console] enabled', () => {
  let server;

  beforeAll(async () => {
    // Three seconds idle, so the timeout can be watched.
    server = await startServer({ configLines: ['[console]', 'enabled = true', 'idle_minutes = 0.05'] });
  });

  afterAll(async () => {
    await server?.stop();
  });

  test('the page is served to a logged-in request, with the terminal and its assets', async () => {
    const res = await fetch(`${server.baseUrl}/_console`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="terminal"');
    expect(html).toContain('/_console/vendor/xterm/lib/xterm.js');
    expect(html).toContain('/_console/vendor/xterm/css/xterm.css');
    expect(html).toContain('/static/js/console.js');
  });

  test('the navbar links to the console on other pages', async () => {
    const res = await fetch(`${server.baseUrl}/_git`, { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/_console"');
  });

  test('xterm is served from node_modules', async () => {
    const res = await fetch(`${server.baseUrl}/_console/vendor/xterm/lib/xterm.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const css = await fetch(`${server.baseUrl}/_console/vendor/xterm/css/xterm.css`);
    expect(css.status).toBe(200);
  });

  test('an upgrade without a session is refused', async () => {
    await expect(openSocket(socketUrl(server.baseUrl))).rejects.toThrow(/401/);
  });

  test('a logged-in upgrade gets a shell in the Today checkout, sized by the browser', async () => {
    const ws = await openSocket(socketUrl(server.baseUrl), authHeaders);
    const state = collect(ws);
    try {
      await waitFor(() => state.hello, 'hello');
      expect(state.hello.cwd).toBe(PROJECT_ROOT);
      expect(state.hello.idleMinutes).toBe(0.05);
      ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      input(ws, 'printf "cwd=%s size=%s\\n" "$PWD" "$(stty size)"\n');
      await waitFor(() => state.text.includes(`cwd=${PROJECT_ROOT} size=40 120`), 'the shell to answer');
      expect(state.closeCode).toBeNull();
    } finally {
      ws.close();
    }
  });

  test('exiting the shell closes the socket', async () => {
    const ws = await openSocket(socketUrl(server.baseUrl), authHeaders);
    const state = collect(ws);
    await waitFor(() => state.hello, 'hello');
    input(ws, 'exit 3\n');
    await waitFor(() => state.closeCode !== null, 'the socket to close');
    expect(state.exitCode).toBe(3);
    expect(state.closeCode).toBe(CLOSE_SHELL_EXITED);
  });

  test('a shell nothing is typed into is closed after the idle time', async () => {
    const ws = await openSocket(socketUrl(server.baseUrl), authHeaders);
    const state = collect(ws);
    await waitFor(() => state.hello, 'hello');
    await waitFor(() => state.closeCode !== null, 'the idle timeout', 15_000);
    expect(state.closeCode).toBe(CLOSE_IDLE);
    expect(state.text).toContain('idle');
  });
});

describe('without a [console] section', () => {
  let server;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server?.stop();
  });

  test('the page is a 404 and the navbar has no console link', async () => {
    const page = await fetch(`${server.baseUrl}/_console`, { headers: authHeaders });
    expect(page.status).toBe(404);
    const git = await fetch(`${server.baseUrl}/_git`, { headers: authHeaders });
    expect(git.status).toBe(200);
    expect(await git.text()).not.toContain('href="/_console"');
  });

  test('the upgrade is refused even with a login', async () => {
    await expect(openSocket(socketUrl(server.baseUrl), authHeaders)).rejects.toThrow(/404/);
  });

  test('the terminal assets are not served', async () => {
    const res = await fetch(`${server.baseUrl}/_console/vendor/xterm/lib/xterm.js`);
    expect(res.status).toBe(404);
  });
});
