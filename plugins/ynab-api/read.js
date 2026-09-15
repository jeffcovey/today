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
import { selectBudgets } from './select-budgets.js';

const require = createRequire(import.meta.url);

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const sourceId = process.env.SOURCE_ID || 'ynab-api/default';
const contextOnly = process.env.CONTEXT_ONLY === 'true';

const API_BASE = 'https://api.ynab.com/v1';
const apiToken = config.api_token || '';
const budgetIdsConfig = (config.budget_ids || '').trim();
const excludeBudgetIdsConfig = (config.exclude_budget_ids || '').trim();
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

async function fetchAllBudgets() {
  const data = await apiFetch(`${API_BASE}/budgets`);
  return data.data.budgets;
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

// Scheduled transactions live on their own endpoint — /transactions returns only
// transactions that have actually occurred. Omitting this drops every upcoming
// bill and recurring charge the user has set up (issue #477).
async function fetchScheduledTransactions(budgetId, lastKnowledge) {
  const url = lastKnowledge != null
    ? `${API_BASE}/budgets/${budgetId}/scheduled_transactions?last_knowledge_of_server=${lastKnowledge}`
    : `${API_BASE}/budgets/${budgetId}/scheduled_transactions`;
  const data = await apiFetch(url);
  return {
    scheduled: data.data.scheduled_transactions,
    server_knowledge: data.data.server_knowledge
  };
}

// One row per rule, dated date_next — deliberately not projected occurrences.
// Projections are synthetic and drift: of the CSV export's projected rows, 27 had
// already diverged from what actually cleared. frequency/date_first are carried in
// metadata so a consumer can project if it wants to.
function convertScheduled(st, budgetId, budgetName, categoryMap) {
  const cat = categoryMap[st.category_id] || null;

  return {
    id: `${budgetId}:scheduled:${st.id}`,
    date: st.date_next,
    account: st.account_name || '',
    payee: st.payee_name || '',
    category: cat?.name || st.category_name || '',
    category_group: cat?.group_name || '',
    amount: st.amount / 1000,
    memo: st.memo || '',
    cleared: '',
    flag: st.flag_color || '',
    scheduled: true,
    metadata: JSON.stringify({
      budget_id: budgetId,
      budget_name: budgetName,
      ynab_id: st.id,
      scheduled: true,
      frequency: st.frequency,
      date_first: st.date_first,
      date_next: st.date_next,
      account_id: st.account_id,
      transfer_account_id: st.transfer_account_id || null
    })
  };
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
    scheduled: false,
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

function removeTransactions(projectRoot, sourceId, toDelete, droppedBudgets) {
  let purgedRows = 0;
  if (toDelete.length === 0 && droppedBudgets.length === 0) return purgedRows;

  let Database;
  try {
    Database = require('better-sqlite3');
    const db = new Database(path.join(projectRoot, '.data', 'today.db'));

    if (toDelete.length > 0) {
      const del = db.prepare('DELETE FROM financial_transactions WHERE id = ?');
      db.transaction(ids => {
        for (const id of ids) purgedRows += del.run(id).changes;
      })(toDelete);
    }

    // Entry ids are `${sourceId}:${budget_id}:${ynab_tx_id}` — see convertTransaction
    if (droppedBudgets.length > 0) {
      const purge = db.prepare(
        "DELETE FROM financial_transactions WHERE source = ? AND id LIKE ? ESCAPE '\\'"
      );
      db.transaction(list => {
        for (const b of list) {
          const prefix = `${sourceId}:${b.id}:`.replace(/[\\%_]/g, c => `\\${c}`);
          purgedRows += purge.run(sourceId, `${prefix}%`).changes;
        }
      })(droppedBudgets);
    }

    db.close();
  } catch (err) {
    console.error(`Warning: could not remove transactions: ${err.message}`);
  }

  return purgedRows;
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

  let allBudgets;
  try {
    allBudgets = await fetchAllBudgets();
  } catch (err) {
    console.log(JSON.stringify({ entries: [], metadata: { error: `Failed to fetch budgets: ${err.message}` } }));
    process.exit(1);
  }

  const { selected: budgets, excluded, skippedByAllowlist, unmatched } = selectBudgets(allBudgets, {
    budgetIds: budgetIdsConfig,
    excludeBudgetIds: excludeBudgetIdsConfig
  });
  const allBudgetIds = new Set(allBudgets.map(b => b.id));
  const disappeared = Object.entries(state.budgets || {})
    .filter(([id]) => !allBudgetIds.has(id))
    .map(([id, budgetState]) => ({ id, name: budgetState.budget_name || id }));
  const droppedBudgets = [...excluded, ...skippedByAllowlist, ...disappeared];

  const warnings = [
    ...unmatched.exclude.map(
      rule => `exclude_budget_ids entry "${rule}" matched no budget — check for a typo or a renamed budget`
    ),
    ...unmatched.include.map(
      rule => `budget_ids entry "${rule}" matched no budget — check for a typo or a renamed budget`
    )
  ];

  // Budgets filtered out of the sync should not keep stale delta-sync state.
  for (const b of droppedBudgets) {
    if (state.budgets[b.id]) delete state.budgets[b.id];
  }
  if (allBudgets.length === 0) state.budgets = {};

  if (budgets.length === 0) {
    const purgedRows = removeTransactions(projectRoot, sourceId, [], droppedBudgets);
    const hint = allBudgets.length === 0
      ? 'Your YNAB account has no budgets'
      : `All ${allBudgets.length} budget(s) were filtered out by budget_ids/exclude_budget_ids`;
    saveState(state);
    console.log(JSON.stringify({
      entries: [],
      metadata: {
        message: 'No YNAB budgets to sync',
        hint,
        all_budgets: allBudgets.map(b => ({ id: b.id, name: b.name })),
        excluded,
        skipped_by_budget_ids: skippedByAllowlist,
        unmatched_rules: unmatched,
        warnings,
        rows_purged: purgedRows
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

    // Scheduled transactions come from their own endpoint and their own
    // server_knowledge cursor — the transactions cursor does not cover them.
    let scheduledAdded = 0;
    let scheduledDeleted = 0;
    try {
      const schedResult = await fetchScheduledTransactions(
        budget.id,
        budgetState.scheduled_server_knowledge ?? null
      );
      for (const st of schedResult.scheduled) {
        if (st.deleted) {
          toDelete.push(`${sourceId}:${budget.id}:scheduled:${st.id}`);
          scheduledDeleted++;
          continue;
        }
        // A rule with no next occurrence has nothing to date a row with
        if (!st.date_next) continue;
        entries.push(convertScheduled(st, budget.id, budget.name, categoryMap));
        scheduledAdded++;
      }
      budgetState.scheduled_server_knowledge = schedResult.server_knowledge;
    } catch (err) {
      console.error(`Warning: could not fetch scheduled transactions for "${budget.name}": ${err.message}`);
    }

    state.budgets[budget.id] = {
      server_knowledge: txResult.server_knowledge,
      scheduled_server_knowledge: budgetState.scheduled_server_knowledge ?? null,
      budget_name: budget.name,
      last_synced: new Date().toISOString()
    };

    budgetsSynced.push({
      name: budget.name,
      added,
      deleted,
      scheduled_added: scheduledAdded,
      scheduled_deleted: scheduledDeleted
    });
  }

  // Remove deleted transactions directly — the plugin loader's INSERT OR REPLACE
  // flow doesn't handle row deletions; we do it here the same way ynab-finance
  // handles budget_allocations. Rows for dropped budgets go in the same pass, so
  // excluding a budget actually removes its data rather than stranding it.
  const purgedRows = removeTransactions(projectRoot, sourceId, toDelete, droppedBudgets);

  if (purgedRows > 0) {
    console.error(`Removed ${purgedRows} row(s) belonging to ${droppedBudgets.length} excluded budget(s)`);
  }

  saveState(state);

  // Pass files_processed = [] so the plugin loader treats this as incremental
  // (INSERT OR REPLACE only, no full-table wipe). Deleted rows were handled above.
  console.log(JSON.stringify({
    entries,
    files_processed: [],
    incremental: true,
    metadata: {
      // Every budget the account has, so one appearing later is visible in sync
      // output rather than quietly absent.
      all_budgets: allBudgets.map(b => ({ id: b.id, name: b.name })),
      budgets: budgetsSynced,
      excluded_budgets: excluded,
      skipped_by_budget_ids: skippedByAllowlist,
      unmatched_rules: unmatched,
      warnings,
      rows_purged: purgedRows,
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
