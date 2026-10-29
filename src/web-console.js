/**
 * The web console: a shell on the server, inside the web view.
 *
 * A WebSocket upgrade on CONSOLE_SOCKET_PATH, authenticated the same way as
 * every page, gets a PTY running the login shell with the Today checkout as
 * its working directory. Messages both ways are JSON text frames:
 *
 *   client → server  {type: 'input', data}   {type: 'resize', cols, rows}
 *   server → client  {type: 'hello', cwd, shell, idleMinutes}
 *                    {type: 'output', data}   {type: 'exit', code, signal}
 *
 * Off unless `[console] enabled = true` is in config.toml: this is a shell for
 * anyone holding a valid session.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { getConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(__dirname, '..');
export const CONSOLE_PATH = '/_console';
export const CONSOLE_SOCKET_PATH = '/_console/socket';

export const DEFAULT_IDLE_MINUTES = 30;
const MAX_IDLE_MINUTES = 24 * 60;
const MAX_COLS = 500;
const MAX_ROWS = 300;
const PING_INTERVAL_MS = 30_000;
const OUTPUT_HIGH_WATER_MARK = 1 * 1024 * 1024;
const OUTPUT_LOW_WATER_MARK = 256 * 1024;
const OUTPUT_HARD_LIMIT = 8 * 1024 * 1024;
const OUTPUT_DRAIN_INTERVAL_MS = 50;
const STARTUP_QUIET_MS = 150;
const STARTUP_FALLBACK_MS = 1500;

// WebSocket close codes in the application range (4000-4999).
export const CLOSE_IDLE = 4000;
export const CLOSE_SHELL_EXITED = 4001;

function defaultShell() {
  const fromEnv = process.env.SHELL;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const candidate of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'sh';
}

// A hand-edited number: anything that is not a finite number within range
// falls back to the default. Zero means "never" for the idle timeout.
function boundedNumber(value, fallback, max) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max) return fallback;
  return n;
}

export function getConsoleConfig(raw) {
  if (arguments.length === 0) {
    raw = getConfig('console');
  }
  const section = raw && typeof raw === 'object' ? raw : {};
  const shell = typeof section.shell === 'string' && section.shell.trim()
    ? section.shell.trim()
    : defaultShell();
  return {
    // Opt-in: an absent section leaves every existing deployment without a shell.
    enabled: section.enabled === true,
    idleMinutes: boundedNumber(section.idle_minutes, DEFAULT_IDLE_MINUTES, MAX_IDLE_MINUTES),
    shell,
    // Typed into the shell once it is up, so its startup files still load and
    // the prompt comes back when the command ends.
    command: typeof section.command === 'string' ? section.command.replace(/[\r\n]+/g, ' ').trim() : ''
  };
}

// The shell gets the server's environment minus dotenvx's markers, so that
// bin/* scripts started from it load .env afresh instead of inheriting
// whatever secrets were current when the web server started.
export function shellEnvironment(base = process.env, appRoot = APP_ROOT) {
  const envFileKeys = new Set();
  try {
    const envFile = fs.readFileSync(path.join(appRoot, '.env'), 'utf8');
    for (const match of envFile.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
      envFileKeys.add(match[1]);
    }
  } catch {
    // A checkout without .env has no names to refresh.
  }

  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('DOTENVX_')) continue;
    if (envFileKeys.has(key) &&
        key !== 'DOTENV_PRIVATE_KEY' &&
        !key.startsWith('DOTENV_PRIVATE_KEY_')) continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (!env.LANG) env.LANG = 'C.UTF-8';
  return env;
}

function clientAddress(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function dimension(value, fallback, max) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback;
}

function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function originMatchesHost(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || !host) return false;
  try {
    const originUrl = new URL(origin);
    const hostUrl = new URL(`http://${host}`);
    return ['http:', 'https:'].includes(originUrl.protocol) &&
      !originUrl.username && !originUrl.password &&
      originUrl.host.toLowerCase() === hostUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

function hasBearerHeader(req) {
  const authorization = req.headers.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ');
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

async function loadPty() {
  const mod = await import('node-pty');
  return mod.default?.spawn ? mod.default : mod;
}

/**
 * Attach the console's WebSocket endpoint to an http.Server.
 *
 * `authenticate(req, { bearerOnly })` resolves to true when the upgrade request
 * is authenticated. `getConfigFn` is read on every upgrade so that switching
 * the console on or off in config.toml needs no restart.
 */
export function attachConsole(server, {
  authenticate,
  getConfigFn = getConsoleConfig,
  appRoot = APP_ROOT,
  log = console.log,
  loadPtyFn = loadPty
} = {}) {
  if (typeof authenticate !== 'function') {
    throw new Error('attachConsole needs an authenticate(req) function');
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    try {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      if (pathname !== CONSOLE_SOCKET_PATH) {
        socket.destroy();
        return;
      }

      const hasOrigin = req.headers.origin !== undefined;
      if (hasOrigin ? !originMatchesHost(req) : !hasBearerHeader(req)) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }

      let config;
      try {
        config = getConfigFn();
      } catch (error) {
        log(`[console] could not read config: ${error.message}`);
        rejectUpgrade(socket, 500, 'Internal Server Error');
        return;
      }
      if (!config.enabled) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }

      let authenticated = false;
      try {
        authenticated = await authenticate(req, { bearerOnly: !hasOrigin });
      } catch (error) {
        log(`[console] authentication failed: ${error.message}`);
      }
      if (!authenticated) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        openShell(ws, req, config).catch((error) => {
          log(`[console] could not start a shell: ${error.message}`);
          send(ws, { type: 'output', data: `\r\n[console] could not start a shell: ${error.message}\r\n` });
          ws.close(1011, 'shell failed');
        });
      });
    } catch (error) {
      log(`[console] upgrade failed: ${error.message}`);
      if (!socket.destroyed) socket.destroy();
    }
  });

  async function openShell(ws, req, config) {
    const pty = await loadPtyFn();
    const address = clientAddress(req);
    if (ws.readyState !== ws.OPEN) {
      log(`[console] socket closed before shell start for ${address}`);
      return;
    }
    const term = pty.spawn(config.shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: appRoot,
      env: shellEnvironment(process.env, appRoot)
    });
    log(`[console] shell opened for ${address} (pid ${term.pid}, ${config.shell}, cwd ${appRoot})`);

    let closed = false;
    let idleTimer = null;
    let outputPaused = false;
    const idleMs = config.idleMinutes * 60_000;

    // The startup command is typed once the shell has drawn its prompt (its
    // output has gone quiet), not the instant the PTY opens, or the tty echoes
    // the keystrokes raw before the shell takes over. Early client input
    // submits it first so the two never share a line. Only real input holds
    // off the idle timeout.
    let startupTimer = null;
    let startupDeadlineTimer = null;
    let startupDone = !config.command;
    const runStartupCommand = () => {
      if (startupDone || closed) return;
      startupDone = true;
      clearTimeout(startupTimer);
      clearTimeout(startupDeadlineTimer);
      term.write(`${config.command}\n`);
    };
    const scheduleStartupCommand = (quietMs) => {
      if (startupDone) return;
      clearTimeout(startupTimer);
      startupTimer = setTimeout(runStartupCommand, quietMs);
    };

    const finish = (code, reason) => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(startupTimer);
      clearTimeout(startupDeadlineTimer);
      clearInterval(pingTimer);
      clearInterval(outputDrainTimer);
      try { term.kill(); } catch { /* already gone */ }
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
      log(`[console] shell closed for ${address} (pid ${term.pid}, ${reason})`);
    };

    const touch = () => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        send(ws, { type: 'output', data: `\r\n[console] closed after ${config.idleMinutes} idle minutes\r\n` });
        finish(CLOSE_IDLE, 'idle');
      }, idleMs);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    };

    // Proxies drop quiet connections; a ping every so often keeps them open,
    // and a missed pong means the browser is gone.
    let alive = true;
    const pingTimer = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }, PING_INTERVAL_MS);
    if (typeof pingTimer.unref === 'function') pingTimer.unref();
    ws.on('pong', () => { alive = true; });

    const updateOutputBackpressure = () => {
      if (closed) return;
      if (!outputPaused && ws.bufferedAmount > OUTPUT_HIGH_WATER_MARK) {
        outputPaused = true;
        try { term.pause(); } catch { /* exited */ }
      } else if (outputPaused && ws.bufferedAmount < OUTPUT_LOW_WATER_MARK) {
        outputPaused = false;
        try { term.resume(); } catch { /* exited */ }
      }
    };
    const outputDrainTimer = setInterval(updateOutputBackpressure, OUTPUT_DRAIN_INTERVAL_MS);
    if (typeof outputDrainTimer.unref === 'function') outputDrainTimer.unref();
    term.onData((data) => {
      scheduleStartupCommand(STARTUP_QUIET_MS);
      if (ws.readyState !== ws.OPEN) return;
      const payload = JSON.stringify({ type: 'output', data });
      if (ws.bufferedAmount + Buffer.byteLength(payload) > OUTPUT_HARD_LIMIT) {
        finish(1013, 'output buffer limit');
        return;
      }
      ws.send(payload);
      updateOutputBackpressure();
    });
    term.onExit(({ exitCode, signal }) => {
      send(ws, { type: 'exit', code: exitCode, signal });
      finish(CLOSE_SHELL_EXITED, 'shell exited');
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'input' && typeof message.data === 'string') {
        touch();
        runStartupCommand();
        term.write(message.data);
      } else if (message.type === 'resize') {
        const cols = dimension(message.cols, 80, MAX_COLS);
        const rows = dimension(message.rows, 24, MAX_ROWS);
        try { term.resize(cols, rows); } catch { /* exited */ }
      }
    });
    ws.on('close', () => finish(1000, 'client closed'));
    ws.on('error', (error) => {
      log(`[console] socket error for ${address}: ${error.message}`);
      finish(1011, 'socket error');
    });

    send(ws, { type: 'hello', cwd: appRoot, shell: config.shell, idleMinutes: config.idleMinutes });
    touch();
    if (!startupDone) startupDeadlineTimer = setTimeout(runStartupCommand, STARTUP_FALLBACK_MS);
  }

  return {
    wss,
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    }
  };
}
