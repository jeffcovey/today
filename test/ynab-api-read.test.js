import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const readScript = path.join(repoRoot, 'plugins', 'ynab-api', 'read.js');

const ARCHIVED = { id: 'f019497d-bb49-4c5c-aa3b-6cd15bc0595f', name: 'My Budget (Archived on 2024-03-03)' };
const CURRENT = { id: '370e8c58-7dc8-401b-91e8-40a84e1ea9c8', name: '2024 Fresh Start' };

function createFetchMock(tempRoot, budgets) {
  const mockPath = path.join(tempRoot, 'mock-fetch.mjs');
  fs.writeFileSync(mockPath, `
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/v1/budgets')) {
    return {
      ok: true,
      json: async () => (${JSON.stringify({ data: { budgets } })})
    };
  }
  throw new Error(\`Unexpected URL: \${url}\`);
};
`);
  return mockPath;
}

function runReadPlugin(projectRoot, mockPath, pluginConfig = {}) {
  return spawnSync('node', ['--import', mockPath, readScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      SOURCE_ID: 'ynab-api/test',
      PLUGIN_CONFIG: JSON.stringify({
        api_token: 'test-token',
        ...pluginConfig
      })
    }
  });
}

describe('ynab-api read plugin', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ynab-api-read-'));
    fs.mkdirSync(path.join(tempRoot, '.data'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('clears stale budget state when every budget is filtered out', () => {
    const statePath = path.join(tempRoot, '.data', 'ynab-api-test-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      budgets: {
        [ARCHIVED.id]: { server_knowledge: 11 },
        [CURRENT.id]: { server_knowledge: 22 }
      }
    }));

    const run = runReadPlugin(
      tempRoot,
      createFetchMock(tempRoot, [ARCHIVED, CURRENT]),
      { exclude_budget_ids: `${ARCHIVED.id},${CURRENT.id}` }
    );

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      entries: [],
      metadata: {
        message: 'No YNAB budgets to sync'
      }
    });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ budgets: {} });
  });
});
