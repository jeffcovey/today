/**
 * MCP write safeguards: tool kinds gated by [mcp] read_only and
 * allow_destructive, title checks, dry_run defaults, and the write log.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { clearConfigCache } from '../src/config.js';
import {
  getMcpPolicy,
  isKindAllowed,
  refusalReason,
  verifyTitle,
  isDryRun,
  logWrite,
} from '../src/mcp-safeguards.js';
import { validateTool, setRegisteredToolsForTesting, getRegisteredTools } from '../src/mcp-tools/index.js';
import { createMCPServer } from '../src/mcp-server.js';

describe('policy', () => {
  test('defaults: writes on, destructive off, log in logs/mcp-writes', () => {
    expect(getMcpPolicy({ raw: {} })).toEqual({ readOnly: false, allowDestructive: false, writeLogDir: 'logs/mcp-writes' });
  });

  test('settings and the connection flag', () => {
    expect(getMcpPolicy({ raw: { allow_destructive: true, write_log: 'notes/mcp' } }))
      .toEqual({ readOnly: false, allowDestructive: true, writeLogDir: 'notes/mcp' });
    expect(getMcpPolicy({ raw: { write_log: false } }).writeLogDir).toBeNull();
    expect(getMcpPolicy({ readOnly: true, raw: {} }).readOnly).toBe(true);
    expect(getMcpPolicy({ raw: { read_only: true } }).readOnly).toBe(true);
  });

  test('which kinds each policy allows', () => {
    const open = { readOnly: false, allowDestructive: true };
    const normal = { readOnly: false, allowDestructive: false };
    const ro = { readOnly: true, allowDestructive: true };
    expect(['read', 'write', 'destructive'].map(k => isKindAllowed(k, open))).toEqual([true, true, true]);
    expect(['read', 'write', 'destructive'].map(k => isKindAllowed(k, normal))).toEqual([true, true, false]);
    expect(['read', 'write', 'destructive'].map(k => isKindAllowed(k, ro))).toEqual([true, false, false]);
    expect(refusalReason('delete_event', 'destructive', normal)).toMatch(/allow_destructive = true/);
    expect(refusalReason('create_task', 'write', ro)).toMatch(/read-only/);
  });
});

describe('verifyTitle', () => {
  const line = '- [ ] Contact **Donald** Schmoll 🔁 every 6 weeks ⏳ 2026-11-01 📅 2026-11-03';

  test('matches the whole title or a distinctive part, ignoring case and markers', () => {
    expect(verifyTitle('contact donald schmoll', line)).toEqual({ ok: true });
    expect(verifyTitle('Donald Schmoll', line)).toEqual({ ok: true });
  });

  test('refuses a missing, too-short or different title', () => {
    expect(verifyTitle('', line, { what: 'task' }).error).toMatch(/title is required/);
    expect(verifyTitle('Do', line).ok).toBe(false);
    const wrong = verifyTitle('Call the plumber', line, { what: 'task' });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/Nothing was changed/);
  });
});

test('dry_run is on unless sent false', () => {
  expect(isDryRun({})).toBe(true);
  expect(isDryRun({ dry_run: true })).toBe(true);
  expect(isDryRun({ dry_run: false })).toBe(false);
});

describe('logWrite', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-log-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('appends one entry per write to a dated file in the vault', async () => {
    const policy = { writeLogDir: 'logs/mcp-writes' };
    const result = { content: [{ type: 'text', text: 'Created task: Buy milk' }] };
    const file = logWrite({ tool: 'create_task', kind: 'write', args: { title: 'Buy milk' }, result, policy, vaultPath: dir });
    logWrite({ tool: 'complete_task', kind: 'write', args: { task_id: 'x' }, result: { isError: true, content: [{ type: 'text', text: 'Error: Title mismatch' }] }, policy, vaultPath: dir });
    expect(path.dirname(file)).toBe(path.join(dir, 'logs/mcp-writes'));
    const text = await fs.readFile(file, 'utf8');
    expect(text).toMatch(/^# MCP writes, \d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/`create_task` \(write\) ok: Created task: Buy milk/);
    expect(text).toMatch(/`complete_task` \(write\) refused or failed: Error: Title mismatch/);
    expect(text).toContain('args: `{"title":"Buy milk"}`');
  });

  test('turned off, it writes nothing', () => {
    expect(logWrite({ tool: 't', kind: 'write', args: {}, result: {}, policy: { writeLogDir: null }, vaultPath: dir })).toBeNull();
  });
});

describe('registry', () => {
  test('rejects a malformed tool', () => {
    expect(validateTool({ name: 'Bad Name', kind: 'risky', description: '', inputSchema: {}, handler: null }))
      .toHaveLength(5);
  });

  test('the directory loads, with valid modules only', async () => {
    setRegisteredToolsForTesting(null);
    const tools = await getRegisteredTools();
    expect(tools).toBeInstanceOf(Map);
  });
});

describe('server enforcement', () => {
  let workDir;
  let previousConfig;
  const calls = [];

  const sample = [
    { name: 'peek', kind: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: 'peeked' }] }) },
    { name: 'jot', kind: 'write', description: 'Write', inputSchema: { type: 'object', properties: {} },
      handler: async (args) => { calls.push(['jot', args]); return { content: [{ type: 'text', text: 'jotted' }] }; } },
    { name: 'shred', kind: 'destructive', description: 'Delete', inputSchema: { type: 'object', properties: {} },
      handler: async () => { calls.push(['shred']); return { content: [{ type: 'text', text: 'shredded' }] }; } },
  ];

  async function withConfig(toml) {
    await fs.writeFile(path.join(workDir, 'config.toml'), toml);
    clearConfigCache();
  }

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-mcp-guard-'));
    await fs.mkdir(path.join(workDir, 'vault'));
    previousConfig = process.env.TODAY_CONFIG;
    process.env.TODAY_CONFIG = path.join(workDir, 'config.toml');
    setRegisteredToolsForTesting(sample);
  });

  afterAll(async () => {
    setRegisteredToolsForTesting(null);
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
    return client;
  }

  test('destructive tools are hidden and refused until allowed', async () => {
    await withConfig(`vault_path = "${path.join(workDir, 'vault')}"\n[mcp]\nwrite_log = "${path.join(workDir, 'log')}"\n`);
    const client = await openPair();
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['peek', 'jot']));
    expect(names).not.toContain('shred');
    const refused = await client.callTool({ name: 'shred', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/allow_destructive/);
    expect(calls.some(c => c[0] === 'shred')).toBe(false);
    await client.close();

    await withConfig(`vault_path = "${path.join(workDir, 'vault')}"\n[mcp]\nallow_destructive = true\nwrite_log = "${path.join(workDir, 'log')}"\n`);
    const allowed = await openPair();
    expect((await allowed.listTools()).tools.map(t => t.name)).toContain('shred');
    expect((await allowed.callTool({ name: 'shred', arguments: {} })).content[0].text).toBe('shredded');
    await allowed.close();
  });

  test('read-only hides every write and destructive tool, even when allowed', async () => {
    await withConfig(`vault_path = "${path.join(workDir, 'vault')}"\n[mcp]\nallow_destructive = true\nwrite_log = false\n`);
    const client = await openPair({ readOnly: true });
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('peek');
    expect(names).not.toContain('jot');
    expect(names).not.toContain('shred');
    expect((await client.callTool({ name: 'jot', arguments: {} })).isError).toBe(true);
    await client.close();
  });

  test('writes are logged; reads are not', async () => {
    const logDir = path.join(workDir, 'log2');
    await withConfig(`vault_path = "${path.join(workDir, 'vault')}"\n[mcp]\nwrite_log = "${logDir}"\n`);
    const client = await openPair();
    await client.callTool({ name: 'peek', arguments: {} });
    await client.callTool({ name: 'jot', arguments: { note: 'hello' } });
    await client.close();
    const [file] = await fs.readdir(logDir);
    const text = await fs.readFile(path.join(logDir, file), 'utf8');
    expect(text).toContain('`jot` (write) ok: jotted');
    expect(text).not.toContain('peek');
  });
});
