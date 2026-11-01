/**
 * The MCP server over HTTP, inside the web view.
 *
 * Mounts the Streamable HTTP transport at MCP_PATH so a remote client
 * (a claude.ai custom connector, Claude Desktop pointed at a URL) reaches
 * the same tools, resources and prompts as `bin/mcp-server` does over stdio,
 * through the existing nginx and TLS.
 *
 * Off unless `[mcp] enabled = true` is in config.toml. Every request must
 * carry `Authorization: Bearer <MCP_TOKEN>`; the token is its own secret,
 * separate from the web password, so a connector can be revoked on its own.
 * `[mcp] read_only = true` hides and refuses the tools that write.
 */

import crypto from 'crypto';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getConfig } from './config.js';
import { createMCPServer } from './mcp-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MCP_PATH = '/mcp';
export const MCP_TOKEN_ENV = 'MCP_TOKEN';
// A connector that never sends DELETE would otherwise hold a server forever.
export const SESSION_IDLE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function getMcpConfig(raw) {
  if (arguments.length === 0) {
    raw = getConfig('mcp');
  }
  const section = raw && typeof raw === 'object' ? raw : {};
  return {
    // Opt-in: an absent section leaves every existing deployment closed.
    enabled: section.enabled === true,
    readOnly: section.read_only === true
  };
}

export function bearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Compare equal-length buffers so the length check does not short-circuit
  // the constant-time comparison on the secret itself.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The token from the environment, generated and stored in .env the first
 * time the endpoint is enabled, the same way the web password is.
 */
export function getOrCreateMcpToken() {
  if (process.env[MCP_TOKEN_ENV]) return process.env[MCP_TOKEN_ENV];
  const token = crypto.randomBytes(32).toString('base64url');
  try {
    execSync(`npx dotenvx set ${MCP_TOKEN_ENV} "${token}"`, {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    process.env[MCP_TOKEN_ENV] = token;
    console.log(`Generated new MCP token (encrypted in .env; read it with: npx dotenvx get ${MCP_TOKEN_ENV})`);
  } catch (error) {
    console.error('Warning: Could not save MCP token to .env:', error.message);
  }
  return token;
}

function jsonRpcError(res, status, code, message) {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * One Express handler for GET, POST and DELETE on MCP_PATH. Sessions live in
 * memory: the first POST (an initialize request) gets a transport and its
 * own MCP server; later requests find them by the Mcp-Session-Id header.
 */
export function createMcpHandler({
  config = getMcpConfig,
  token = () => process.env[MCP_TOKEN_ENV],
  createServer = createMCPServer
} = {}) {
  const sessions = new Map();

  async function handler(req, res) {
    const { enabled, readOnly } = config();
    if (!enabled) {
      res.status(404).json({ error: 'The MCP endpoint is switched off. Add a [mcp] section with enabled = true to config.toml to turn it on.' });
      return;
    }
    const expected = token();
    if (!expected) {
      res.status(503).json({ error: `${MCP_TOKEN_ENV} is not set` });
      return;
    }
    if (!tokenMatches(bearerToken(req), expected)) {
      res.set('WWW-Authenticate', 'Bearer realm="today"');
      res.status(401).json({ error: 'A valid bearer token is required' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        jsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      jsonRpcError(res, 400, -32000, 'Bad Request: no valid session ID provided');
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { transport, server, readOnly, lastSeen: Date.now() }); },
      onsessionclosed: (id) => { sessions.delete(id); }
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = await createServer({ readOnly });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  async function closeIdle(now = Date.now()) {
    for (const [id, session] of sessions) {
      if (now - session.lastSeen < SESSION_IDLE_MS) continue;
      sessions.delete(id);
      await session.transport.close().catch(() => {});
    }
  }
  setInterval(() => { closeIdle().catch(() => {}); }, SWEEP_INTERVAL_MS).unref();

  handler.sessions = sessions;
  handler.closeIdle = closeIdle;
  return handler;
}

export function attachMcp(app, options) {
  const handler = createMcpHandler(options);
  app.all(MCP_PATH, (req, res, next) => handler(req, res).catch(next));
  return handler;
}
