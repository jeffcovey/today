/**
 * Registry of MCP tools defined in modules under src/mcp-tools/.
 *
 * Every `*.js` file here (except this one and files starting with `_`) is a
 * tool module, loaded once. A module exports `tools`, an array of:
 *
 *   {
 *     name: 'timer_status',
 *     kind: 'read' | 'write' | 'destructive',   // see src/mcp-safeguards.js
 *     pluginType: 'time-logs',                   // listed only when enabled; null = always
 *     description: '...',
 *     inputSchema: { type: 'object', properties: { ... } },
 *     handler: async (args, ctx) => ({ content: [...] }),
 *   }
 *
 * `ctx` is { db, policy, syncForRead }. Write and destructive
 * handlers must verify titles and honor dry_run themselves where their
 * tool calls for it; the server enforces kinds and logs every write.
 *
 * Modules are discovered from the directory, so PRs that add tools don't
 * all edit one list.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { TOOL_KINDS } from '../mcp-safeguards.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

let loading = null;

export function validateTool(tool, file = 'module') {
  const problems = [];
  if (!tool || typeof tool !== 'object') return [`${file}: tool is not an object`];
  if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool.name)) problems.push(`${file}: bad name ${tool.name}`);
  if (!TOOL_KINDS.has(tool.kind)) problems.push(`${file}: ${tool.name} has kind ${tool.kind}`);
  if (typeof tool.description !== 'string' || !tool.description) problems.push(`${file}: ${tool.name} has no description`);
  if (!tool.inputSchema || tool.inputSchema.type !== 'object') problems.push(`${file}: ${tool.name} needs an object inputSchema`);
  if (typeof tool.handler !== 'function') problems.push(`${file}: ${tool.name} has no handler`);
  return problems;
}

async function loadAll() {
  const files = fs.readdirSync(DIR)
    .filter(f => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_'))
    .sort();
  const tools = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(DIR, file)).href);
    for (const tool of mod.tools || []) {
      const problems = validateTool(tool, file);
      if (problems.length > 0) throw new Error(`Invalid MCP tool: ${problems.join('; ')}`);
      if (tools.has(tool.name)) throw new Error(`Duplicate MCP tool name ${tool.name} in ${file}`);
      tools.set(tool.name, { pluginType: null, ...tool });
    }
  }
  return tools;
}

/** All registered tools, by name. */
export function getRegisteredTools() {
  if (!loading) {
    loading = loadAll().catch(error => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

/**
 * Replace the registry, for tests. Pass null to go back to the directory.
 * @param {Array|null} list
 */
export function setRegisteredToolsForTesting(list) {
  if (list === null) {
    loading = null;
    return;
  }
  const tools = new Map();
  for (const tool of list) {
    const problems = validateTool(tool, 'test');
    if (problems.length > 0) throw new Error(problems.join('; '));
    tools.set(tool.name, { pluginType: null, ...tool });
  }
  loading = Promise.resolve(tools);
}
