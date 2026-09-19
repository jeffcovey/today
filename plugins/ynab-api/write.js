#!/usr/bin/env node

// YNAB API Finance Plugin — write command (issue #463)
//
// Applies edits back to YNAB. YNAB is the source of truth: this writes there and
// lets the next sync read the result back, rather than editing the local row.
//
// Read-modify-write, deliberately — see transaction-update.js for why a sparse
// patch is unsafe here. This file is the I/O shell; the decisions live there.

import {
  WriteRefused,
  resolveCategoryId,
  assertWritable,
  assertEditable,
  buildTransactionUpdate
} from './transaction-update.js';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const entry = JSON.parse(process.env.ENTRY_JSON || '{}');

const API_BASE = 'https://api.ynab.com/v1';
const apiToken = config.api_token || '';

function fail(error, hint) {
  console.log(JSON.stringify({ success: false, error, ...(hint ? { hint } : {}) }));
  process.exit(1);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error?.detail) detail = parsed.error.detail;
    } catch { /* not JSON */ }
    throw new Error(`YNAB API ${res.status} ${res.statusText}: ${detail}`);
  }
  return res.json();
}

async function main() {
  if (!apiToken) {
    fail('No YNAB API token configured. Run: bin/plugins configure ynab-api');
  }

  let metadata = {};
  try {
    metadata = typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : (entry.metadata || {});
  } catch {
    fail('Entry metadata is not valid JSON; cannot determine which YNAB transaction to update');
  }

  try {
    assertWritable(metadata, entry);
  } catch (err) {
    fail(err.message, err.hint);
  }

  const { budget_id: budgetId, ynab_id: ynabId } = metadata;

  // 1. Read current state, so omitted fields keep their values
  let current;
  try {
    const res = await apiFetch(`${API_BASE}/budgets/${budgetId}/transactions/${ynabId}`);
    current = res.data.transaction;
  } catch (err) {
    fail(`Could not read the transaction before updating it: ${err.message}`);
  }

  try {
    assertEditable(current, entry);
  } catch (err) {
    fail(err.message, err.hint);
  }

  // 2. Resolve a category name to an id, if one was supplied
  let categoryId;
  if (entry.category !== undefined && entry.category !== null) {
    try {
      const cats = await apiFetch(`${API_BASE}/budgets/${budgetId}/categories`);
      categoryId = resolveCategoryId(cats.data.category_groups, entry.category);
    } catch (err) {
      fail(err.message, err instanceof WriteRefused ? err.hint : undefined);
    }
  }

  // 3. Overlay onto current state
  const { update, changed } = buildTransactionUpdate(current, entry, categoryId);

  if (changed.length === 0) {
    // Not an error — the desired state already holds. Skip the write and the sync.
    console.log(JSON.stringify({
      success: true,
      unchanged: true,
      message: 'Already in the requested state; nothing sent to YNAB',
      needs_sync: false
    }));
    return;
  }

  // 4. Write the complete merged object
  let result;
  try {
    result = await apiFetch(`${API_BASE}/budgets/${budgetId}/transactions/${ynabId}`, {
      method: 'PUT',
      body: JSON.stringify({ transaction: update })
    });
  } catch (err) {
    fail(`Failed to update transaction: ${err.message}`);
  }

  const updated = result.data.transaction;

  console.log(JSON.stringify({
    success: true,
    entry: {
      id: `${budgetId}:${updated.id}`,
      date: updated.date,
      account: updated.account_name,
      payee: updated.payee_name,
      category: updated.category_name,
      amount: updated.amount / 1000,
      memo: updated.memo,
      cleared: updated.cleared,
      flag: updated.flag_color
    },
    updated_fields: changed,
    // server_knowledge advances, so the next sync reads this back
    needs_sync: true
  }));
}

main().catch(err => {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
