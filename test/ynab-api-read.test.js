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

// transactionsByBudgetId answers every /transactions request; deltaByBudgetId,
// when given, answers last_knowledge_of_server requests instead, so a test can
// give the delta feed and the full listing different contents, as YNAB does.
function createFetchMock(tempRoot, {
  budgets,
  transactionsByBudgetId = {},
  deltaByBudgetId = null
}) {
  const mockPath = path.join(tempRoot, 'mock-fetch.mjs');
  const urlLog = path.join(tempRoot, 'urls.log');
  fs.writeFileSync(mockPath, `
import fs from 'fs';
const transactionsByBudgetId = ${JSON.stringify(transactionsByBudgetId)};
const deltaByBudgetId = ${JSON.stringify(deltaByBudgetId)};

globalThis.fetch = async (url) => {
  fs.appendFileSync(${JSON.stringify(urlLog)}, String(url) + '\\n');
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
    const isDelta = String(url).includes('last_knowledge_of_server=');
    const source = isDelta && deltaByBudgetId ? deltaByBudgetId : transactionsByBudgetId;
    return {
      ok: true,
      json: async () => ({
        data: {
          transactions: source[budgetId] || [],
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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
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
    db.exec(`CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, source TEXT, date DATE, scheduled BOOLEAN DEFAULT 0, superseded_by TEXT
    )`);
    const insert = db.prepare(
      'INSERT INTO financial_transactions (id, source, date, scheduled) VALUES (?, ?, ?, ?)'
    );
    for (const row of rows) {
      insert.run(row.id, row.source, row.date ?? daysAgo(1), row.scheduled ? 1 : 0);
    }
    db.close();
  }

  function cachedIds() {
    const db = new Database(path.join(tempRoot, '.data', 'today.db'), { readonly: true });
    const ids = db.prepare('SELECT id FROM financial_transactions ORDER BY id').all().map(r => r.id);
    db.close();
    return ids;
  }

  function requestedUrls() {
    return fs.readFileSync(path.join(tempRoot, 'urls.log'), 'utf8').trim().split('\n');
  }

  const statePath = () => path.join(tempRoot, '.data', 'ynab-api-test-state.json');

  function writeState(budgetState) {
    fs.writeFileSync(statePath(), JSON.stringify({ budgets: { [CURRENT.id]: budgetState } }));
  }

  const tx = (id, fields = {}) => ({
    id,
    date: daysAgo(3),
    amount: -10000,
    payee_name: 'Shop',
    account_name: 'Checking',
    cleared: 'cleared',
    approved: true,
    deleted: false,
    matched_transaction_id: null,
    import_payee_name: null,
    ...fields
  });

  // The hidden half of a matched import, as YNAB's delta feed reports it
  const shadow = (id, matchedId) => tx(id, {
    payee_name: null,
    approved: false,
    matched_transaction_id: matchedId,
    import_payee_name: JSON.stringify({
      payeeId: 'p', importedPayee: 'Bill Payment', matchedUserTransactionId: matchedId, accepted: false
    })
  });

  const rowId = (ynabId) => `ynab-api/test:${CURRENT.id}:${ynabId}`;

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
  describe('cache convergence (issue #604)', () => {
    test('a full refresh removes cached rows YNAB no longer returns, within the window only', () => {
      const scheduledInstance = '875eedfc-8081-4cd3-afe5-a17dc4eb103f_2026-09-22';
      createDbWithRows([
        { id: rowId('live-1'), source: 'ynab-api/test' },
        { id: rowId(scheduledInstance), source: 'ynab-api/test' },
        // merged into another entry / re-posted under a new id — no tombstone ever sent
        { id: rowId('merged-away'), source: 'ynab-api/test' },
        // same trailing 36 chars as the scheduled instance, but a different id
        { id: rowId('ffffffff-8081-4cd3-afe5-a17dc4eb103f_2026-09-22'), source: 'ynab-api/test' },
        { id: rowId('scheduled:rule-1'), source: 'ynab-api/test', scheduled: true },
        { id: rowId('older-than-window'), source: 'ynab-api/test', date: daysAgo(400) },
        { id: `ynab-api/test:${ARCHIVED.id}:other-budget`, source: 'ynab-api/test' },
        { id: `ynab-finance/test:${CURRENT.id}:csv`, source: 'ynab-finance/test' }
      ]);

      const run = runReadPlugin(tempRoot, createFetchMock(tempRoot, {
        budgets: [CURRENT],
        transactionsByBudgetId: { [CURRENT.id]: [tx('live-1'), tx(scheduledInstance)] }
      }), { budget_ids: CURRENT.id });

      expect(run.status).toBe(0);
      const out = JSON.parse(run.stdout);
      expect(out.metadata.budgets[0]).toMatchObject({ full_refresh: true, stale_removed: 2 });
      expect(out.metadata.rows_purged).toBe(2);
      expect(out.entries.map(e => e.id).sort()).toEqual(
        [`${CURRENT.id}:live-1`, `${CURRENT.id}:${scheduledInstance}`].sort()
      );
      expect(cachedIds()).toEqual([
        `ynab-api/test:${ARCHIVED.id}:other-budget`,
        rowId(scheduledInstance),
        rowId('live-1'),
        rowId('older-than-window'),
        rowId('scheduled:rule-1'),
        `ynab-finance/test:${CURRENT.id}:csv`
      ].sort());

      const txUrl = requestedUrls().find(u => /\/transactions\b/.test(u) && !u.includes('scheduled_'));
      expect(txUrl).toMatch(/since_date=\d{4}-\d{2}-\d{2}/);
      expect(txUrl).not.toMatch(/last_knowledge_of_server/);

      const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      expect(state.budgets[CURRENT.id].last_full_refresh).toEqual(expect.any(String));
    });

    test('between full refreshes, delta sync is used and does not prune', () => {
      writeState({ server_knowledge: 5, last_full_refresh: new Date().toISOString() });
      createDbWithRows([
        { id: rowId('live-1'), source: 'ynab-api/test' },
        { id: rowId('not-in-delta'), source: 'ynab-api/test' }
      ]);

      const run = runReadPlugin(tempRoot, createFetchMock(tempRoot, {
        budgets: [CURRENT],
        transactionsByBudgetId: { [CURRENT.id]: [tx('live-1')] }
      }));

      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).metadata.budgets[0]).toMatchObject({ full_refresh: false, stale_removed: 0 });
      expect(requestedUrls().some(u => u.includes('last_knowledge_of_server=5'))).toBe(true);
      expect(cachedIds()).toEqual([rowId('live-1'), rowId('not-in-delta')]);
    });

    test('a full refresh runs again once full_refresh_hours have passed', () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      writeState({ server_knowledge: 5, last_full_refresh: twoDaysAgo });
      createDbWithRows([{ id: rowId('gone'), source: 'ynab-api/test' }]);

      const run = runReadPlugin(tempRoot, createFetchMock(tempRoot, {
        budgets: [CURRENT],
        transactionsByBudgetId: { [CURRENT.id]: [] }
      }), { full_refresh_hours: 24 });

      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).metadata.budgets[0]).toMatchObject({ full_refresh: true, stale_removed: 1 });
      expect(cachedIds()).toEqual([]);
    });

    test('state from before this fix (no last_full_refresh) triggers a full refresh', () => {
      writeState({ server_knowledge: 5 });
      createDbWithRows([{ id: rowId('gone'), source: 'ynab-api/test' }]);

      const run = runReadPlugin(tempRoot, createFetchMock(tempRoot, {
        budgets: [CURRENT],
        transactionsByBudgetId: { [CURRENT.id]: [] }
      }));

      expect(run.status).toBe(0);
      expect(cachedIds()).toEqual([]);
    });

    test('matched-import shadows in the delta feed are dropped and purged from the cache', () => {
      writeState({ server_knowledge: 5, last_full_refresh: new Date().toISOString() });
      createDbWithRows([
        { id: rowId('user-entry'), source: 'ynab-api/test' },
        { id: rowId('shadow-1'), source: 'ynab-api/test' }
      ]);

      const run = runReadPlugin(tempRoot, createFetchMock(tempRoot, {
        budgets: [CURRENT],
        transactionsByBudgetId: {
          [CURRENT.id]: [
            tx('user-entry', { matched_transaction_id: 'shadow-1', import_payee_name: 'Bill Payment' }),
            shadow('shadow-1', 'user-entry')
          ]
        }
      }));

      expect(run.status).toBe(0);
      const out = JSON.parse(run.stdout);
      expect(out.entries.map(e => e.id)).toEqual([`${CURRENT.id}:user-entry`]);
      expect(out.metadata.budgets[0].matched_import_shadows_skipped).toBe(1);
      expect(cachedIds()).toEqual([rowId('user-entry')]);
    });

    test('brace-prefixed imported payees without match-state fields are kept', () => {
      writeState({ server_knowledge: 5, last_full_refresh: new Date().toISOString() });
      const malformed = '{not json';
      const ordinaryJson = JSON.stringify({ note: 'literal statement payee' });
      const run = runReadPlugin(tempRoot, createFetchMock(tempRoot, {
        budgets: [CURRENT],
        transactionsByBudgetId: {
          [CURRENT.id]: [
            tx('malformed-payee', {
              payee_name: null,
              matched_transaction_id: 'manual-1',
              import_payee_name: malformed
            }),
            tx('ordinary-json-payee', {
              payee_name: null,
              matched_transaction_id: 'manual-2',
              import_payee_name: ordinaryJson
            })
          ]
        }
      }));

      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).entries.map(e => [e.id, e.payee])).toEqual([
        [`${CURRENT.id}:malformed-payee`, malformed],
        [`${CURRENT.id}:ordinary-json-payee`, ordinaryJson]
      ]);
      expect(JSON.parse(run.stdout).metadata.budgets[0].matched_import_shadows_skipped).toBe(0);
    });

    test('a JSON import_payee_name is never used as the payee', () => {
      const run = runReadPlugin(tempRoot, createFetchMock(tempRoot, {
        budgets: [CURRENT],
        transactionsByBudgetId: {
          [CURRENT.id]: [tx('t1', {
            payee_name: null,
            import_payee_name: JSON.stringify({
              importedPayee: 'Bill Payment', accepted: false
            })
          })]
        }
      }));

      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).entries[0].payee).toBe('Bill Payment');
    });

    test('a failed full-refresh prune leaves the next sync due for a full refresh', () => {
      const previousRefresh = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      writeState({ server_knowledge: 5, last_full_refresh: previousRefresh });
      const db = new Database(path.join(tempRoot, '.data', 'today.db'));
      db.exec('CREATE TABLE financial_transactions (id TEXT PRIMARY KEY, source TEXT)');
      db.close();
      const mock = createFetchMock(tempRoot, { budgets: [CURRENT] });

      const firstRun = runReadPlugin(tempRoot, mock);
      expect(firstRun.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(statePath(), 'utf8')).budgets[CURRENT.id].last_full_refresh)
        .toBe(previousRefresh);

      const secondRun = runReadPlugin(tempRoot, mock);
      expect(secondRun.status).toBe(0);
      const transactionUrls = requestedUrls().filter(u => /\/transactions\b/.test(u) && !u.includes('scheduled_'));
      expect(transactionUrls).toHaveLength(2);
      expect(transactionUrls.every(u => u.includes('since_date='))).toBe(true);
    });
  });
});
