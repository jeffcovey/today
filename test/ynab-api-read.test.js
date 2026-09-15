import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const readScript = path.join(repoRoot, 'plugins', 'ynab-api', 'read.js');

const ARCHIVED = { id: 'f019497d-bb49-4c5c-aa3b-6cd15bc0595f', name: 'My Budget (Archived on 2024-03-03)' };
const CURRENT = { id: '370e8c58-7dc8-401b-91e8-40a84e1ea9c8', name: '2024 Fresh Start' };
const MISSING = { id: '99999999-1111-2222-3333-444444444444', name: 'Removed Budget' };

function createFetchMock(tempRoot, {
  budgets,
  transactionsByBudgetId = {}
}) {
  const mockPath = path.join(tempRoot, 'mock-fetch.mjs');
  const transactionsJson = JSON.stringify(transactionsByBudgetId);
  fs.writeFileSync(mockPath, `
const transactionsByBudgetId = ${transactionsJson};

globalThis.fetch = async (url) => {
  if (String(url).endsWith('/v1/budgets')) {
    return {
      ok: true,
      json: async () => (${JSON.stringify({ data: { budgets } })})
    };
  }
  const categoriesMatch = String(url).match(/\\/v1\\/budgets\\/([^/]+)\\/categories$/);
  if (categoriesMatch) {
    return {
      ok: true,
      json: async () => (${JSON.stringify({ data: { category_groups: [] } })})
    };
  }
  const transactionsMatch = String(url).match(/\\/v1\\/budgets\\/([^/]+)\\/transactions/);
  if (transactionsMatch) {
    const budgetId = transactionsMatch[1];
    return {
      ok: true,
      json: async () => ({
        data: {
          transactions: transactionsByBudgetId[budgetId] || [],
          server_knowledge: 1
        }
      })
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

  function createDbWithRows(rows) {
    const db = new Database(path.join(tempRoot, '.data', 'today.db'));
    db.exec('CREATE TABLE financial_transactions (id TEXT PRIMARY KEY, source TEXT)');
    const insert = db.prepare('INSERT INTO financial_transactions (id, source) VALUES (?, ?)');
    for (const row of rows) insert.run(row.id, row.source);
    db.close();
  }

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
      createFetchMock(tempRoot, { budgets: [ARCHIVED, CURRENT] }),
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

  test('returns unmatched-rule warnings in structured metadata', () => {
    const run = runReadPlugin(
      tempRoot,
      createFetchMock(tempRoot, { budgets: [CURRENT] }),
      { exclude_budget_ids: 'Budget That Does Not Exist' }
    );

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).metadata).toMatchObject({
      unmatched_rules: { exclude: ['Budget That Does Not Exist'] },
      warnings: [
        'exclude_budget_ids entry "Budget That Does Not Exist" matched no budget — check for a typo or a renamed budget'
      ]
    });
  });

  test('purges persisted rows when every budget is excluded', () => {
    createDbWithRows([
      { id: `ynab-api/test:${ARCHIVED.id}:old-1`, source: 'ynab-api/test' },
      { id: `ynab-api/test:${CURRENT.id}:old-2`, source: 'ynab-api/test' },
      { id: `other-source:${CURRENT.id}:keep`, source: 'other-source' }
    ]);

    const run = runReadPlugin(
      tempRoot,
      createFetchMock(tempRoot, { budgets: [ARCHIVED, CURRENT] }),
      { exclude_budget_ids: `${ARCHIVED.id},${CURRENT.id}` }
    );

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).metadata.rows_purged).toBe(2);

    const db = new Database(path.join(tempRoot, '.data', 'today.db'), { readonly: true });
    const rows = db.prepare('SELECT id, source FROM financial_transactions ORDER BY id').all();
    db.close();
    expect(rows).toEqual([{ id: `other-source:${CURRENT.id}:keep`, source: 'other-source' }]);
  });

  test('counts transaction deletions in rows_purged for deletion-only incremental syncs', () => {
    createDbWithRows([
      { id: `ynab-api/test:${CURRENT.id}:deleted-tx`, source: 'ynab-api/test' }
    ]);

    const run = runReadPlugin(
      tempRoot,
      createFetchMock(tempRoot, {
        budgets: [CURRENT],
        transactionsByBudgetId: {
          [CURRENT.id]: [{ id: 'deleted-tx', deleted: true }]
        }
      })
    );

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).metadata).toMatchObject({
      rows_purged: 1,
      transactions_deleted: 1
    });
  });

  test('purges rows and state for budgets no longer returned by YNAB', () => {
    const statePath = path.join(tempRoot, '.data', 'ynab-api-test-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      budgets: {
        [MISSING.id]: { server_knowledge: 10, budget_name: MISSING.name }
      }
    }));
    createDbWithRows([
      { id: `ynab-api/test:${MISSING.id}:old-1`, source: 'ynab-api/test' },
      { id: `other-source:${CURRENT.id}:keep`, source: 'other-source' }
    ]);

    const run = runReadPlugin(
      tempRoot,
      createFetchMock(tempRoot, {
        budgets: [CURRENT],
        transactionsByBudgetId: { [CURRENT.id]: [] }
      })
    );

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).metadata.rows_purged).toBe(1);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({
      budgets: {
        [CURRENT.id]: expect.objectContaining({ server_knowledge: 1, budget_name: CURRENT.name })
      }
    });

    const db = new Database(path.join(tempRoot, '.data', 'today.db'), { readonly: true });
    const rows = db.prepare('SELECT id, source FROM financial_transactions ORDER BY id').all();
    db.close();
    expect(rows).toEqual([{ id: `other-source:${CURRENT.id}:keep`, source: 'other-source' }]);
  });
});
