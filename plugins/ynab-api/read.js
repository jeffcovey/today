#!/usr/bin/env node

// YNAB API Finance Plugin — read command
//
// Fetches transactions from the YNAB API using delta sync (server_knowledge).
// On first run: pulls all transactions for each configured budget.
// On subsequent runs: pulls only records that changed since the last sync.
// Deleted transactions are removed from the local DB directly.
//
// IDs are stable YNAB UUIDs prefixed with the budget ID, so INSERT OR REPLACE
// naturally handles updates without duplicates.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const sourceId = process.env.SOURCE_ID || 'ynab-api/default';
const contextOnly = process.env.CONTEXT_ONLY === 'true';

const API_BASE = 'https://api.ynab.com/v1';
const apiToken = config.api_token || '';
const budgetIdsConfig = (config.budget_ids || '').trim();
const retentionDays = config.retention_days || 365;

// Delta-sync state: server_knowledge per budget
const statePath = path.join(projectRoot, '.data', `${sourceId.replace(/\//g, '-')}-state.json`);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { budgets: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function apiFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YNAB API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchBudgets() {
  const data = await apiFetch(`${API_BASE}/budgets`);
  const all = data.data.budgets;
  if (!budgetIdsConfig || budgetIdsConfig === 'all') return all;
  const ids = new Set(budgetIdsConfig.split(',').map(s => s.trim()).filter(Boolean));
  return all.filter(b => ids.has(b.id));
}

// Returns a map of category_id → { name, group_name } for enriching transactions.
// Fetched fresh each sync; the list is small (typically < 5 KB) and rarely changes.
async function fetchCategoryMap(budgetId) {
  const data = await apiFetch(`${API_BASE}/budgets/${budgetId}/categories`);
  const map = {};
  for (const group of data.data.category_groups) {
    for (const cat of group.categories) {
      map[cat.id] = { name: cat.name, group_name: group.name };
    }
  }
  return map;
}

async function fetchTransactions(budgetId, lastKnowledge) {
  const url = lastKnowledge != null
    ? `${API_BASE}/budgets/${budgetId}/transactions?last_knowledge_of_server=${lastKnowledge}`
    : `${API_BASE}/budgets/${budgetId}/transactions`;
  const data = await apiFetch(url);
  return {
    transactions: data.data.transactions,
    server_knowledge: data.data.server_knowledge
  };
}

function convertTransaction(tx, budgetId, budgetName, categoryMap) {
  const amount = tx.amount / 1000; // YNAB stores milliunits
  const cat = categoryMap[tx.category_id] || null;

  return {
    id: `${budgetId}:${tx.id}`,
    date: tx.date,
    account: tx.account_name || '',
    payee: tx.payee_name || tx.import_payee_name || '',
    category: cat?.name || tx.category_name || '',
    category_group: cat?.group_name || '',
    amount,
    memo: tx.memo || '',
    cleared: tx.cleared || '',
    flag: tx.flag_color || '',
    metadata: JSON.stringify({
      budget_id: budgetId,
      budget_name: budgetName,
      ynab_id: tx.id,
      import_id: tx.import_id || null,
      approved: tx.approved,
      account_id: tx.account_id,
      transfer_account_id: tx.transfer_account_id || null
    })
  };
}

// Early exit for context-only mode — data is already in the DB cache
if (contextOnly) {
  console.log(JSON.stringify({ entries: [], files_processed: [], incremental: true, metadata: { skipped: 'context-only' } }));
  process.exit(0);
}

if (!apiToken) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      message: 'No YNAB API token configured',
      hint: 'Get a Personal Access Token from app.ynab.com/settings/developer, then run: bin/plugins configure ynab-api'
    }
  }));
  process.exit(0);
}

async function main() {
  const state = loadState();
  const entries = [];
  const toDelete = [];

  let budgets;
  try {
    budgets = await fetchBudgets();
  } catch (err) {
    console.log(JSON.stringify({ entries: [], metadata: { error: `Failed to fetch budgets: ${err.message}` } }));
    process.exit(1);
  }

  if (budgets.length === 0) {
    console.log(JSON.stringify({
      entries: [],
      metadata: {
        message: 'No YNAB budgets found',
        hint: budgetIdsConfig ? `No budgets matched budget_ids = "${budgetIdsConfig}"` : 'Your YNAB account has no budgets'
      }
    }));
    process.exit(0);
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  const budgetsSynced = [];

  for (const budget of budgets) {
    const budgetState = state.budgets[budget.id] || {};

    let categoryMap = {};
    try {
      categoryMap = await fetchCategoryMap(budget.id);
    } catch (err) {
      console.error(`Warning: could not fetch categories for "${budget.name}": ${err.message}`);
    }

    let txResult;
    try {
      txResult = await fetchTransactions(budget.id, budgetState.server_knowledge ?? null);
    } catch (err) {
      console.error(`Warning: could not fetch transactions for "${budget.name}": ${err.message}`);
      continue;
    }

    let added = 0;
    let deleted = 0;
    for (const tx of txResult.transactions) {
      if (tx.deleted) {
        // Full DB id = sourceId + ":" + entry.id (see plugin-loader insertEntries)
        toDelete.push(`${sourceId}:${budget.id}:${tx.id}`);
        deleted++;
        continue;
      }
      if (tx.date < cutoffStr) continue;
      entries.push(convertTransaction(tx, budget.id, budget.name, categoryMap));
      added++;
    }

    state.budgets[budget.id] = {
      server_knowledge: txResult.server_knowledge,
      budget_name: budget.name,
      last_synced: new Date().toISOString()
    };

    budgetsSynced.push({ name: budget.name, added, deleted });
  }

  // Remove deleted transactions directly — the plugin loader's INSERT OR REPLACE
  // flow doesn't handle row deletions; we do it here the same way ynab-finance
  // handles budget_allocations.
  if (toDelete.length > 0) {
    let Database;
    try {
      Database = require('better-sqlite3');
      const db = new Database(path.join(projectRoot, '.data', 'today.db'));
      const del = db.prepare('DELETE FROM financial_transactions WHERE id = ?');
      const deleteMany = db.transaction(ids => { for (const id of ids) del.run(id); });
      deleteMany(toDelete);
      db.close();
    } catch (err) {
      console.error(`Warning: could not delete ${toDelete.length} removed transaction(s): ${err.message}`);
    }
  }

  saveState(state);

  // Pass files_processed = [] so the plugin loader treats this as incremental
  // (INSERT OR REPLACE only, no full-table wipe). Deleted rows were handled above.
  console.log(JSON.stringify({
    entries,
    files_processed: [],
    incremental: true,
    metadata: {
      budgets: budgetsSynced,
      transactions_upserted: entries.length,
      transactions_deleted: toDelete.length,
      retention_days: retentionDays
    }
  }));
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
