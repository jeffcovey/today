/**
 * The MCP endpoint inside the web server: off without config, closed without
 * the bearer token, and otherwise a full Streamable HTTP MCP session with
 * the same server `bin/mcp-server` runs over stdio.
 */

import { jest } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { clearConfigCache } from '../src/config.js';
import { attachMcp, bearerToken, getMcpConfig, getOrCreateMcpToken, tokenMatches, MCP_PATH, MCP_TOKEN_ENV, SESSION_IDLE_MS } from '../src/web-mcp.js';
import { createMCPServer, WRITE_TOOLS } from '../src/mcp-server.js';
import { startServer } from './helpers/a11y-harness.js';

jest.setTimeout(30_000);

const TOKEN = 'test-token-0123456789';

describe('getMcpConfig', () => {
  test('is off without a section', () => {
    expect(getMcpConfig({})).toEqual({ enabled: false, readOnly: false });
    expect(getMcpConfig(null)).toEqual({ enabled: false, readOnly: false });
  });

  test('needs enabled = true and read_only = true exactly', () => {
    expect(getMcpConfig({ enabled: 'yes' }).enabled).toBe(false);
    expect(getMcpConfig({ enabled: 1 }).enabled).toBe(false);
    expect(getMcpConfig({ enabled: true }).enabled).toBe(true);
    expect(getMcpConfig({ enabled: true, read_only: 'true' }).readOnly).toBe(false);
    expect(getMcpConfig({ enabled: true, read_only: true }).readOnly).toBe(true);
  });
});

describe('bearer tokens', () => {
  test('reads the Bearer scheme case-insensitively and nothing else', () => {
    expect(bearerToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
    expect(bearerToken({ headers: { authorization: 'bearer abc' } })).toBe('abc');
    expect(bearerToken({ headers: { authorization: 'Basic abc' } })).toBeNull();
    expect(bearerToken({ headers: { authorization: 'Bearer' } })).toBeNull();
    expect(bearerToken({ headers: {} })).toBeNull();
  });

  test('matches only the exact token, never an empty one', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches(null, 'abc')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
  });
});

function stubServer({ readOnly }) {
  const server = new Server({ name: 'stub', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', description: readOnly ? 'read-only' : 'read-write', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }]
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
    content: [{ type: 'text', text: `echo: ${params.arguments?.text}` }]
  }));
  return server;
}

describe('getOrCreateMcpToken', () => {
  const quiet = { log: () => {}, error: () => {} };

  test('uses the token already in the environment without touching .env', () => {
    const env = { [MCP_TOKEN_ENV]: 'from-env' };
    const readStored = jest.fn();
    const store = jest.fn();
    expect(getOrCreateMcpToken({ env, readStored, store, log: quiet })).toBe('from-env');
    expect(readStored).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  test('reuses the token stored in .env when the environment lacks it (#701)', () => {
    const env = {};
    const store = jest.fn();
    const token = getOrCreateMcpToken({ env, readStored: () => 'stored-token', store, log: quiet });
    expect(token).toBe('stored-token');
    expect(env[MCP_TOKEN_ENV]).toBe('stored-token');
    expect(store).not.toHaveBeenCalled();
  });

  test('generates and stores a token only when neither has one', () => {
    const env = {};
    const store = jest.fn();
    const token = getOrCreateMcpToken({ env, readStored: () => null, store, log: quiet });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store).toHaveBeenCalledWith(token);
    expect(env[MCP_TOKEN_ENV]).toBe(token);
  });

  test('a second start after generation reuses the generated token', () => {
    const vault = {};
    const store = jest.fn((t) => { vault.token = t; });
    const first = getOrCreateMcpToken({ env: {}, readStored: () => vault.token || null, store, log: quiet });
    const second = getOrCreateMcpToken({ env: {}, readStored: () => vault.token || null, store, log: quiet });
    expect(second).toBe(first);
    expect(store).toHaveBeenCalledTimes(1);
  });
});

describe('the /mcp endpoint', () => {
  let httpServer;
  let baseUrl;
  let handler;
  let config;

  beforeAll(async () => {
    config = { enabled: true, read_only: false };
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    handler = attachMcp(app, { config: () => getMcpConfig(config), token: () => TOKEN, createServer: stubServer });
    await new Promise((resolve) => { httpServer = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}${MCP_PATH}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
  });

  function connect(token) {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), { requestInit: { headers } });
    return { client, transport, open: () => client.connect(transport) };
  }

  test('is 404 while the section is off', async () => {
    config.enabled = false;
    try {
      const res = await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` }, body: '{}' });
      expect(res.status).toBe(404);
    } finally {
      config.enabled = true;
    }
  });

  test('refuses a missing or wrong token with 401 before any session work', async () => {
    const res = await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);

    const wrong = connect('not-the-token');
    await expect(wrong.open()).rejects.toThrow(/bearer token is required/);
    expect(handler.sessions.size).toBe(0);
  });

  test('a request naming an unknown session is 404, and one with no session and no initialize is 400', async () => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` };
    const unknown = await fetch(baseUrl, { method: 'POST', headers: { ...headers, 'mcp-session-id': 'nope' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(unknown.status).toBe(404);
    const noSession = await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(noSession.status).toBe(400);
  });

  test('runs a full session with the right token and forgets it when the client ends it', async () => {
    const { client, transport, open } = connect(TOKEN);
    await open();
    expect(handler.sessions.size).toBe(1);

    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['echo']);
    expect(tools[0].description).toBe('read-write');

    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(result.content[0].text).toBe('echo: hi');

    await transport.terminateSession();
    await client.close();
    expect(handler.sessions.size).toBe(0);
  });

  test('drops a session that goes quiet without a DELETE', async () => {
    const { client, open } = connect(TOKEN);
    await open();
    const [session] = handler.sessions.values();
    await handler.closeIdle(session.lastSeen + SESSION_IDLE_MS - 1);
    expect(handler.sessions.size).toBe(1);
    await handler.closeIdle(session.lastSeen + SESSION_IDLE_MS);
    expect(handler.sessions.size).toBe(0);
    await client.close();
  });

  test('passes read_only through to each new session', async () => {
    config.read_only = true;
    const { client, open } = connect(TOKEN);
    try {
      await open();
      const { tools } = await client.listTools();
      expect(tools[0].description).toBe('read-only');
    } finally {
      await client.close();
      config.read_only = false;
    }
  });

  test('invalidates existing sessions when the read-only policy changes', async () => {
    const { client, open } = connect(TOKEN);
    const previousSessionIds = new Set(handler.sessions.keys());
    await open();
    const sessionId = [...handler.sessions.keys()].find(id => !previousSessionIds.has(id));
    expect(handler.sessions.get(sessionId).readOnly).toBe(false);
    config.read_only = true;
    let readOnlyClient;

    try {
      const authorization = ['Be' + 'arer', TOKEN].join(' ');
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization,
          'mcp-session-id': sessionId
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      });
      expect(res.status).toBe(404);
      expect(handler.sessions.has(sessionId)).toBe(false);

      const reconnect = connect(TOKEN);
      readOnlyClient = reconnect.client;
      await reconnect.open();
      expect((await readOnlyClient.listTools()).tools[0].description).toBe('read-only');
    } finally {
      await client.close();
      if (readOnlyClient) await readOnlyClient.close();
      config.read_only = false;
    }
  });
});

describe('createMCPServer read-only mode', () => {
  let workDir;
  let previousConfig;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-mcp-'));
    await fs.writeFile(path.join(workDir, 'config.toml'), 'vault_path = "vault"\n');
    previousConfig = process.env.TODAY_CONFIG;
    process.env.TODAY_CONFIG = path.join(workDir, 'config.toml');
    clearConfigCache();
  });

  afterAll(async () => {
    if (previousConfig === undefined) delete process.env.TODAY_CONFIG;
    else process.env.TODAY_CONFIG = previousConfig;
    clearConfigCache();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  async function openPair(options) {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMCPServer(options);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server };
  }

  test('lists the write tools by default and hides them when read-only', async () => {
    const full = await openPair();
    const names = (await full.client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['sync_data', 'query_database']));
    await full.client.close();

    const readOnly = await openPair({ readOnly: true });
    const roNames = (await readOnly.client.listTools()).tools.map(t => t.name);
    expect(roNames).toContain('query_database');
    expect(roNames.filter(name => WRITE_TOOLS.has(name))).toEqual([]);
    await readOnly.client.close();
  });

  test('refuses a write tool by name on a read-only server', async () => {
    const { client } = await openPair({ readOnly: true });
    const result = await client.callTool({ name: 'sync_data', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/read-only/);
    await client.close();
  });
});

describe('the real web server', () => {
  let server;
  let previousToken;

  beforeAll(async () => {
    previousToken = process.env.MCP_TOKEN;
    // Set before launch: with the section on and no token, the server would
    // otherwise generate one into the project's own .env.
    process.env.MCP_TOKEN = TOKEN;
    server = await startServer({ configLines: ['[mcp]', 'enabled = true', 'read_only = true'] });
  }, 90_000);

  afterAll(async () => {
    if (previousToken === undefined) delete process.env.MCP_TOKEN;
    else process.env.MCP_TOKEN = previousToken;
    if (server) await server.stop();
  });

  test('serves /mcp behind the bearer token, not the session login', async () => {
    const res = await fetch(`${server.baseUrl}${MCP_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}', redirect: 'manual' });
    expect(res.status).toBe(401);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
    });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).toContain('query_database');
      expect(names).not.toContain('sync_data');

      const result = await client.callTool({ name: 'query_database', arguments: { sql: 'SELECT title FROM tasks ORDER BY title' } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text).map(row => row.title)).toEqual(['Open task due today', 'Overdue objective']);
    } finally {
      await transport.terminateSession();
      await client.close();
    }
  });
});
