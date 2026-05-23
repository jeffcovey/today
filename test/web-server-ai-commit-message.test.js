import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const TEST_USERNAME = 'admin';
const TEST_PASSWORD = 'adminpass';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer({ port, mode }) {
  await fs.mkdir(path.join(REPO_ROOT, '.data'), { recursive: true });
  const configPath = path.join(REPO_ROOT, `.tmp-web-server-ai-commit-config-${port}.toml`);
  await fs.writeFile(configPath, 'vault_path = "."\n', 'utf8');

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    WEB_PORT: String(port),
    WEB_USER: TEST_USERNAME,
    WEB_PASSWORD: TEST_PASSWORD,
    TODAY_CONFIG: configPath,
    TODAY_TEST_AI_COMMIT_STREAM_MODE: mode,
  };

  const proc = spawn('node', ['src/web-server.js'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let ready = false;
  let stderr = '';
  const readyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting web server. stderr: ${stderr}`));
    }, 15000);

    proc.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Web server running on')) {
        ready = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    proc.on('exit', (code) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`Web server exited before ready (code ${code}). stderr: ${stderr}`));
      }
    });
  });

  await readyPromise;
  return { proc, configPath };
}

async function stopServer(server) {
  if (!server) return;
  if (server.proc && !server.proc.killed) {
    server.proc.kill('SIGTERM');
    await new Promise((resolve) => server.proc.once('exit', resolve));
  }
  if (server.configPath) {
    await fs.rm(server.configPath, { force: true });
  }
}

async function login(port) {
  const response = await fetch(`http://127.0.0.1:${port}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(TEST_USERNAME)}&password=${encodeURIComponent(TEST_PASSWORD)}`,
    redirect: 'manual',
  });

  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Failed to get session cookie from login');
  return setCookie.split(';')[0];
}

function parseSseEvents(raw) {
  return raw
    .split('\n\n')
    .map((eventText) => eventText.trim())
    .filter(Boolean)
    .map((eventText) => eventText.split('\n'))
    .flatMap((lines) => lines.filter((line) => line.startsWith('data:')))
    .map((line) => {
      const payload = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      return JSON.parse(payload);
    });
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

describe('POST /_git/ai-commit-message SSE protocol', () => {
  let server;
  let stagedRelativePath;

  beforeEach(async () => {
    stagedRelativePath = `.tmp-ai-commit-message-${randomUUID()}.txt`;
    const absolutePath = path.join(REPO_ROOT, stagedRelativePath);
    await fs.writeFile(absolutePath, `test diff ${randomUUID()}\n`, 'utf8');
    runGit(['add', stagedRelativePath]);
  });

  afterEach(async () => {
    await stopServer(server);
    server = null;
    if (stagedRelativePath) {
      runGit(['reset', '--', stagedRelativePath]);
      await fs.rm(path.join(REPO_ROOT, stagedRelativePath), { force: true });
      stagedRelativePath = null;
    }
    await sleep(100);
  });

  test('streams text chunks and terminal done event', async () => {
    const port = 3211;
    server = await startServer({ port, mode: 'success' });
    const cookie = await login(port);

    const response = await fetch(`http://127.0.0.1:${port}/_git/ai-commit-message`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = await response.text();
    const events = parseSseEvents(body);

    const textEvents = events.filter((event) => event.type === 'text');
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
    const streamedMessage = textEvents.map((event) => event.content).join('');
    expect(streamedMessage).toMatch(/^feat:\s+/);

    const doneEvent = events.find((event) => event.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent.message).toBe(streamedMessage);
  });

  test('emits SSE error event on stream failure after headers are sent', async () => {
    const port = 3212;
    server = await startServer({ port, mode: 'error' });
    const cookie = await login(port);

    const response = await fetch(`http://127.0.0.1:${port}/_git/ai-commit-message`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = await response.text();
    const events = parseSseEvents(body);

    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('Failed to generate commit message');
  });
});
