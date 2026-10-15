#!/usr/bin/env node

// YNAB API Finance Plugin — read command
//
// Fetches transactions from the YNAB API using delta sync (server_knowledge).
// On first run: pulls all transactions for each configured budget.
// On subsequent runs: pulls only records that changed since the last sync.
// Deleted transactions are removed from the local DB directly.
//
// The delta feed alone does not converge: YNAB drops some transactions without
// ever sending a `deleted: true` tombstone (a pending charge re-posted under a new
// id, an import merged into a scheduled or manual entry), and it reports its
// internal matched-import records as ordinary live transactions. So every
// full_refresh_hours the plugin re-reads the whole retention window and removes
// cached rows YNAB no longer returns (issue #604).
//
// IDs are stable YNAB UUIDs prefixed with the budget ID, so INSERT OR REPLACE
// naturally handles updates without duplicates.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { selectBudgets } from './select-budgets.js';
import { convertYnabAccount, replaceBudgetBalances, removeBudgetBalances } from '../../src/account-balances.js';

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
const fullRefreshHours = Number(config.full_refresh_hours ?? 24);

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

// Accounts carry YNAB's own running balance. The transaction cache keeps only
// retention_days of history, so summing it is not a balance (issue #608).
async function fetchAccounts(budgetId) {
  const data = await apiFetch(`${API_BASE}/budgets/${budgetId}/accounts`);
  return data.data.accounts;
}

function openDb(projectRoot) {
  const Database = require('better-sqlite3');
  return new Database(path.join(projectRoot, '.data', 'today.db'));
}

// Store one budget's live account balances. Returns the number stored, or null
// when they could not be written (the previous snapshot is then left in place).
function storeAccountBalances(projectRoot, sourceId, budgetId, budgetName, accounts) {
  try {
    const asOf = new Date().toISOString();
    const rows = accounts
      .map(acc => convertYnabAccount(acc, budgetId, budgetName, asOf))
      .filter(Boolean);
    const db = openDb(projectRoot);
    try {
      replaceBudgetBalances(db, sourceId, budgetId, rows);
    } finally {
      db.close();
    }
    return rows.length;
  } catch (err) {
    console.error(`Warning: could not store account balances for "${budgetName}": ${err.message}`);
    return null;
  }
}

function purgeAccountBalances(projectRoot, sourceId, budgetIds) {
  if (budgetIds.length === 0) return 0;
  try {
    const db = openDb(projectRoot);
    try {
      return removeBudgetBalances(db, sourceId, budgetIds);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`Warning: could not remove account balances: ${err.message}`);
    return 0;
  }
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
    transfer: Boolean(st.transfer_account_id),
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

// Delta fetch when lastKnowledge is given; otherwise the full listing from
// sinceDate on, which is what a full refresh reconciles the cache against.
async function fetchTransactions(budgetId, lastKnowledge, sinceDate = null) {
  const url = lastKnowledge != null
    ? `${API_BASE}/budgets/${budgetId}/transactions?last_knowledge_of_server=${lastKnowledge}`
    : `${API_BASE}/budgets/${budgetId}/transactions${sinceDate ? `?since_date=${sinceDate}` : ''}`;
  const data = await apiFetch(url);
  return {
    transactions: data.data.transactions,
    server_knowledge: data.data.server_knowledge
  };
}

// YNAB's delta feed (last_knowledge_of_server) returns the hidden half of a
// matched import — the bank-side record YNAB folded into a manual or scheduled
// entry — as a live transaction. The normal listing never returns it, and its
// import_payee_name is YNAB's internal JSON match state rather than a payee
// ({"payeeId":...,"importedSource":...,"accepted":...}). Storing it double counts
// the matched transaction, so it is treated as deleted.
function importPayeeMatchState(tx) {
  if (typeof tx.import_payee_name !== 'string') return null;
  try {
    const parsed = JSON.parse(tx.import_payee_name);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        typeof parsed.accepted !== 'boolean' ||
        ![parsed.payeeId, parsed.importedPayee, parsed.importedSource].some(value => typeof value === 'string')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isMatchedImportShadow(tx) {
  return Boolean(tx.matched_transaction_id) && importPayeeMatchState(tx) !== null;
}

// import_payee_name is normally the cleaned bank payee, but on matched-import
// records it is a JSON blob; never surface that as a payee.
function importPayeeName(tx) {
  const raw = tx.import_payee_name || '';
  const parsed = importPayeeMatchState(tx);
  if (!parsed) return raw;
  return parsed.userImportedPayee || parsed.importedPayee || tx.import_payee_name_original || '';
}

function isFullRefreshDue(budgetState, now = Date.now(), hours = fullRefreshHours) {
  if (budgetState.server_knowledge == null) return true;
  if (!budgetState.last_full_refresh) return true;
  if (!(hours > 0)) return false;
  const last = Date.parse(budgetState.last_full_refresh);
  return !Number.isFinite(last) || now - last >= hours * 3600 * 1000;
}

function convertTransaction(tx, budgetId, budgetName, categoryMap) {
  const amount = tx.amount / 1000; // YNAB stores milliunits
  const cat = categoryMap[tx.category_id] || null;

  return {
    id: `${budgetId}:${tx.id}`,
    date: tx.date,
    account: tx.account_name || '',
    payee: tx.payee_name || importPayeeName(tx),
    category: cat?.name || tx.category_name || '',
    category_group: cat?.group_name || '',
    amount,
    memo: tx.memo || '',
    cleared: tx.cleared || '',
    flag: tx.flag_color || '',
    scheduled: false,
    // Money moving between the user's own accounts: not spending, and YNAB
    // leaves it uncategorised on purpose.
    transfer: Boolean(tx.transfer_account_id),
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

// Rows superseded by a removed row keep a dangling superseded_by until the
// finance reconcile that the plugin loader runs after every finance sync, which
// clears and recomputes the column — so nothing extra is needed here.
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

// After a full refresh: drop this budget's cached real (non-scheduled) rows in
// the refreshed window that YNAB did not return. Returns the number removed.
function pruneMissingTransactions(projectRoot, sourceId, budgetId, sinceDate, liveIds) {
  let removed = 0;
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(projectRoot, '.data', 'today.db');
    if (!fs.existsSync(dbPath)) return { success: true, removed: 0 };
    const db = new Database(dbPath);
    try {
      const prefix = `${sourceId}:${budgetId}:`;
      const escaped = prefix.replace(/[\\%_]/g, c => `\\${c}`);
      const rows = db.prepare(`
        SELECT id FROM financial_transactions
        WHERE source = ? AND id LIKE ? ESCAPE '\\'
          AND IFNULL(scheduled, 0) = 0
          AND date >= ?
      `).all(sourceId, `${escaped}%`, sinceDate);
      const stale = rows
        .map(r => r.id)
        // Scheduled rules have their own endpoint and cursor; never touch them here
        .filter(id => !id.startsWith(`${prefix}scheduled:`))
        .filter(id => !liveIds.has(id.slice(prefix.length)));
      const del = db.prepare('DELETE FROM financial_transactions WHERE id = ?');
      db.transaction(ids => {
        for (const id of ids) removed += del.run(id).changes;
      })(stale);
    } finally {
      db.close();
    }
    return { success: true, removed };
  } catch (err) {
    console.error(`Warning: could not prune transactions missing from YNAB: ${err.message}`);
    return { success: false, removed: 0 };
  }
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
    purgeAccountBalances(projectRoot, sourceId, droppedBudgets.map(b => b.id));
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

    const fullRefresh = isFullRefreshDue(budgetState);

    let txResult;
    try {
      txResult = fullRefresh
        ? await fetchTransactions(budget.id, null, cutoffStr)
        : await fetchTransactions(budget.id, budgetState.server_knowledge ?? null);
    } catch (err) {
      console.error(`Warning: could not fetch transactions for "${budget.name}": ${err.message}`);
      continue;
    }

    let added = 0;
    let deleted = 0;
    let shadowsSkipped = 0;
    const liveIds = new Set();
    for (const tx of txResult.transactions) {
      if (!tx.deleted && isMatchedImportShadow(tx)) {
        toDelete.push(`${sourceId}:${budget.id}:${tx.id}`);
        shadowsSkipped++;
        continue;
      }
      if (tx.deleted) {
        // Full DB id = sourceId + ":" + entry.id (see plugin-loader insertEntries)
        toDelete.push(`${sourceId}:${budget.id}:${tx.id}`);
        deleted++;
        continue;
      }
      if (tx.date < cutoffStr) continue;
      liveIds.add(tx.id);
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

    let accountsStored = null;
    try {
      const accounts = await fetchAccounts(budget.id);
      accountsStored = storeAccountBalances(projectRoot, sourceId, budget.id, budget.name, accounts);
    } catch (err) {
      console.error(`Warning: could not fetch accounts for "${budget.name}": ${err.message}`);
    }

    // Full ids compared as-is: scheduled-instance ids are `<uuid>_<YYYY-MM-DD>`
    let pruneResult = { success: true, removed: 0 };
    if (fullRefresh) {
      pruneResult = pruneMissingTransactions(projectRoot, sourceId, budget.id, cutoffStr, liveIds);
    }
    const staleRemoved = pruneResult.removed;

    const nowIso = new Date().toISOString();
    state.budgets[budget.id] = {
      server_knowledge: txResult.server_knowledge,
      scheduled_server_knowledge: budgetState.scheduled_server_knowledge ?? null,
      budget_name: budget.name,
      last_synced: nowIso,
      last_full_refresh: fullRefresh && pruneResult.success
        ? nowIso
        : (budgetState.last_full_refresh ?? null)
    };

    budgetsSynced.push({
      name: budget.name,
      full_refresh: fullRefresh,
      added,
      deleted,
      matched_import_shadows_skipped: shadowsSkipped,
      stale_removed: staleRemoved,
      scheduled_added: scheduledAdded,
      scheduled_deleted: scheduledDeleted,
      account_balances_stored: accountsStored
    });
  }

  // Remove deleted transactions directly — the plugin loader's INSERT OR REPLACE
  // flow doesn't handle row deletions; we do it here the same way ynab-finance
  // handles budget_allocations. Rows for dropped budgets go in the same pass, so
  // excluding a budget actually removes its data rather than stranding it.
  const staleRemovedTotal = budgetsSynced.reduce((n, b) => n + b.stale_removed, 0);
  const purgedRows = removeTransactions(projectRoot, sourceId, toDelete, droppedBudgets) + staleRemovedTotal;
  purgeAccountBalances(projectRoot, sourceId, droppedBudgets.map(b => b.id));

  if (droppedBudgets.length > 0 && purgedRows > 0) {
    console.error(`Removed ${purgedRows} row(s), including those of ${droppedBudgets.length} excluded budget(s)`);
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
      stale_removed: staleRemovedTotal,
      retention_days: retentionDays
    }
  }));
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
