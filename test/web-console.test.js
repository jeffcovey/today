/**
 * The web console: a shell on the server behind the web view's login, with
 * the Today checkout as its working directory. Off unless config switches it
 * on; the WebSocket upgrade is refused without a session.
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, PASSWORD, PROJECT_ROOT } from './helpers/a11y-harness.js';
import {
  attachConsole, getConsoleConfig, shellEnvironment, DEFAULT_IDLE_MINUTES, CLOSE_IDLE, CLOSE_SHELL_EXITED
} from '../src/web-console.js';

jest.setTimeout(180_000);

describe('getConsoleConfig', () => {
  test('is off without a section', () => {
    expect(getConsoleConfig({}).enabled).toBe(false);
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

  test('a startup command is optional and trimmed to one line', () => {
    expect(getConsoleConfig({}).command).toBe('');
    expect(getConsoleConfig({ command: 42 }).command).toBe('');
    expect(getConsoleConfig({ command: '  tmux attach \n' }).command).toBe('tmux attach');
    expect(getConsoleConfig({ command: 'cd vault\nls' }).command).toBe('cd vault ls');
  });

  test('the shell defaults to one that exists and accepts an override', () => {
    expect(getConsoleConfig({}).shell).toMatch(/sh$/);
    expect(getConsoleConfig({ shell: ' /bin/sh ' }).shell).toBe('/bin/sh');
    expect(getConsoleConfig({ shell: '   ' }).shell).toMatch(/sh$/);
  });
});

describe('shellEnvironment', () => {
  test('drops dotenvx runtime markers and names the terminal', () => {
    const env = shellEnvironment({
      PATH: '/bin',
      HOME: '/root',
      DOTENVX_RUNNING: '1',
      DOTENV_KEY: 'k',
      DOTENV_PRIVATE_KEY: 'private',
      DOTENV_PRIVATE_KEY_DEPLOYMENT: 'deployment',
      LANG: 'en_US.UTF-8'
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/root',
      DOTENV_KEY: 'k',
      DOTENV_PRIVATE_KEY: 'private',
      DOTENV_PRIVATE_KEY_DEPLOYMENT: 'deployment',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    });
  });

  test('does not inherit names defined in the checkout .env', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'today-console-env-'));
    try {
      fs.writeFileSync(path.join(appRoot, '.env'), [
        'API_TOKEN=encrypted',
        'export DATABASE_URL=encrypted',
        'DOTENV_PUBLIC_KEY=public',
        'DOTENV_PRIVATE_KEY=private'
      ].join('\n'));
      const env = shellEnvironment({
        API_TOKEN: 'stale',
        DATABASE_URL: 'stale',
        DOTENV_PUBLIC_KEY: 'stale',
        DOTENV_PRIVATE_KEY: 'private',
        DOTENV_PRIVATE_KEY_DEPLOYMENT: 'deployment',
        DOTENVX_RUNNING: '1',
        KEEP: 'current'
      }, appRoot);
      expect(env).toMatchObject({
        DOTENV_PRIVATE_KEY: 'private',
        DOTENV_PRIVATE_KEY_DEPLOYMENT: 'deployment',
        KEEP: 'current'
      });
      expect(env).not.toHaveProperty('API_TOKEN');
      expect(env).not.toHaveProperty('DATABASE_URL');
      expect(env).not.toHaveProperty('DOTENV_PUBLIC_KEY');
      expect(env).not.toHaveProperty('DOTENVX_RUNNING');
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
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

describe('PTY startup', () => {
  test('does not spawn a shell if the socket closes while the PTY module loads', async () => {
    const httpServer = createServer();
    const spawn = jest.fn();
    const attached = attachConsole(httpServer, {
      authenticate: async () => true,
      getConfigFn: () => ({ enabled: true, idleMinutes: 0, shell: '/bin/sh' }),
      appRoot: PROJECT_ROOT,
      log: () => {},
      loadPtyFn: () => new Promise((resolve) => {
        setTimeout(() => resolve({ spawn }), 100);
      })
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = httpServer.address();
      const ws = await openSocket(`ws://127.0.0.1:${address.port}/_console/socket`, {
        Origin: `http://127.0.0.1:${address.port}`
      });
      ws.close();
      await waitFor(() => ws.readyState === WebSocket.CLOSED, 'the client socket to close');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      attached.close();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });
});

describe('PTY output backpressure', () => {
  test('pauses and resumes the PTY and closes above the hard output limit', async () => {
    const httpServer = createServer();
    const logs = [];
    let emitOutput;
    const term = {
      pid: 123,
      onData: (handler) => { emitOutput = handler; },
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn()
    };
    const attached = attachConsole(httpServer, {
      authenticate: async () => true,
      getConfigFn: () => ({ enabled: true, idleMinutes: 0, shell: '/bin/sh' }),
      appRoot: PROJECT_ROOT,
      log: (message) => logs.push(message),
      loadPtyFn: async () => ({ spawn: () => term })
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = httpServer.address();
      const ws = await openSocket(`ws://127.0.0.1:${address.port}/_console/socket`, {
        Origin: `http://127.0.0.1:${address.port}`
      });
      const state = collect(ws);
      await waitFor(() => emitOutput, 'the PTY output handler');
      const serverSocket = [...attached.wss.clients][0];
      let bufferedAmount = 0;
      Object.defineProperty(serverSocket, 'bufferedAmount', {
        configurable: true,
        get: () => bufferedAmount
      });

      bufferedAmount = 1.1 * 1024 * 1024;
      emitOutput('slow output');
      expect(term.pause).toHaveBeenCalledTimes(1);

      bufferedAmount = 0;
      await waitFor(() => term.resume.mock.calls.length === 1, 'the PTY to resume');

      bufferedAmount = 8 * 1024 * 1024;
      emitOutput('output beyond the limit');
      await waitFor(() => state.closeCode !== null, 'the socket to close at the hard limit');
      expect(state.closeCode).toBe(1013);
      expect(term.kill).toHaveBeenCalled();
      expect(logs.some((message) => message.includes('output buffer limit'))).toBe(true);
    } finally {
      attached.close();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });
});

describe('with [console] enabled', () => {
  let server;

  beforeAll(async () => {
    // Three seconds idle, so the timeout can be watched.
    server = await startServer({ configLines: [
      '[console]', 'enabled = true', 'idle_minutes = 0.05',
      "command = 'printf \"startup=%s\\n\" ok'"
    ] });
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
    await expect(openSocket(socketUrl(server.baseUrl))).rejects.toThrow(/403/);
  });

  test('rejects a mismatched Origin before authenticating', async () => {
    await expect(openSocket(socketUrl(server.baseUrl), {
      ...authHeaders,
      Origin: 'https://attacker.example'
    })).rejects.toThrow(/403/);
  });

  test('an originless upgrade cannot use a session cookie', async () => {
    const login = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: PASSWORD }).toString()
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    await expect(openSocket(socketUrl(server.baseUrl), { Cookie: cookie })).rejects.toThrow(/403/);
  });

  test('a matching Origin permits an authenticated session cookie', async () => {
    const login = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: PASSWORD }).toString()
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    const ws = await openSocket(socketUrl(server.baseUrl), {
      Cookie: cookie,
      Origin: server.baseUrl
    });
    ws.close();
  });

  test('a malformed upgrade target is rejected without taking down the server', async () => {
    const address = new URL(server.baseUrl);
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: address.hostname,
        port: Number(address.port)
      });
      let data = '';
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('timed out waiting for malformed upgrade response'));
      });
      socket.on('connect', () => {
        socket.write([
          'GET // HTTP/1.1',
          `Host: ${address.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          ''
        ].join('\r\n'));
      });
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\r\n')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    const page = await fetch(`${server.baseUrl}/_git`, { headers: authHeaders });
    expect(page.status).toBe(200);
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

  test('the startup command runs without any typing', async () => {
    const ws = await openSocket(socketUrl(server.baseUrl), authHeaders);
    const state = collect(ws);
    try {
      await waitFor(() => state.text.includes('startup=ok'), 'the startup command output');
    } finally {
      ws.close();
    }
  });

  test('early input submits the startup command before the typed command', async () => {
    const ws = await openSocket(socketUrl(server.baseUrl), authHeaders);
    const state = collect(ws);
    try {
      input(ws, 'printf "typed=%s\\n" ');
      await waitFor(() => state.text.includes('startup=ok'), 'the startup command output');
      input(ws, 'ok\n');
      await waitFor(() => state.text.includes('typed=ok'), 'the typed command output');
      expect(state.text.indexOf('startup=ok')).toBeLessThan(state.text.indexOf('typed=ok'));
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

  test('markdown cache reflects console toggles between requests', async () => {
    const configPath = path.join(server.workDir, 'config.toml');
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    const pageUrl = `${server.baseUrl}/diary/2026-01-15.md`;
    try {
      const first = await fetch(pageUrl, { headers: authHeaders });
      expect(first.status).toBe(200);
      expect(await first.text()).not.toContain('href="/_console"');

      fs.writeFileSync(configPath, `${originalConfig}\n[console]\nenabled = true\n`);
      const enabled = await fetch(pageUrl, { headers: authHeaders });
      expect(enabled.status).toBe(200);
      expect(await enabled.text()).toContain('href="/_console"');

      fs.writeFileSync(configPath, originalConfig);
      const disabled = await fetch(pageUrl, { headers: authHeaders });
      expect(disabled.status).toBe(200);
      expect(await disabled.text()).not.toContain('href="/_console"');
    } finally {
      fs.writeFileSync(configPath, originalConfig);
    }
  });

  test('the upgrade is refused even with a login', async () => {
    await expect(openSocket(socketUrl(server.baseUrl), authHeaders)).rejects.toThrow(/404/);
  });

  test('the terminal assets are not served', async () => {
    const res = await fetch(`${server.baseUrl}/_console/vendor/xterm/lib/xterm.js`);
    expect(res.status).toBe(404);
  });
});
