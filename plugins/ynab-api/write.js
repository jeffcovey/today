#!/usr/bin/env node

// YNAB API Finance Plugin — write command (issue #463)
//
// Applies edits back to YNAB. YNAB is the source of truth: this writes there and
// lets the next sync read the result back, rather than editing the local row.
//
// Read-modify-write, deliberately. YNAB's update endpoint documents `approved` as
// "If not supplied, transaction will be unapproved by default" — so a partial
// update that sets only a category would silently un-approve the transaction.
// Fetching current state first and sending a complete object makes that
// impossible, and costs one extra GET.

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const entry = JSON.parse(process.env.ENTRY_JSON || '{}');

const API_BASE = 'https://api.ynab.com/v1';
const apiToken = config.api_token || '';

function fail(error, extra = {}) {
  console.log(JSON.stringify({ success: false, error, ...extra }));
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

/**
 * Resolve a category name to its id. Callers work in names — "Groceries" — since
 * that is what a person and the AI both see; YNAB needs the uuid.
 *
 * Accepts "Group: Category", because a category name is only unique within its
 * group. An ambiguous name is an error rather than a guess: picking the wrong
 * one files money under the wrong heading and is easy to miss.
 */
async function resolveCategoryId(budgetId, categoryName) {
  const data = await apiFetch(`${API_BASE}/budgets/${budgetId}/categories`);
  const wanted = String(categoryName).trim().toLowerCase();

  const candidates = [];
  for (const group of data.data.category_groups) {
    if (group.deleted || group.hidden) continue;
    for (const cat of group.categories) {
      if (cat.deleted || cat.hidden) continue;
      const full = `${group.name}: ${cat.name}`.toLowerCase();
      if (full === wanted || cat.name.trim().toLowerCase() === wanted) {
        candidates.push({ id: cat.id, name: cat.name, group: group.name });
      }
    }
  }

  if (candidates.length === 0) {
    const available = data.data.category_groups
      .filter(g => !g.deleted && !g.hidden)
      .flatMap(g => g.categories.filter(c => !c.deleted && !c.hidden).map(c => `${g.name}: ${c.name}`));
    throw new Error(
      `No category matching "${categoryName}". Available: ${available.slice(0, 12).join(', ')}` +
      (available.length > 12 ? `, … (${available.length} total)` : '')
    );
  }

  if (candidates.length > 1) {
    throw new Error(
      `"${categoryName}" is ambiguous across ${candidates.length} groups: ` +
      `${candidates.map(c => `${c.group}: ${c.name}`).join(', ')}. ` +
      `Qualify it as "Group: Category".`
    );
  }

  return candidates[0].id;
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

  const budgetId = metadata.budget_id;
  const ynabId = metadata.ynab_id;

  if (!budgetId || !ynabId) {
    fail(
      'Entry is missing budget_id or ynab_id in metadata — only transactions synced from ynab-api can be written back',
      { hint: 'Rows from the CSV export plugin carry no YNAB id and cannot be updated via the API' }
    );
  }

  if (metadata.scheduled) {
    fail(
      'This is a scheduled transaction; it lives on a different YNAB endpoint and is not writable here',
      { hint: 'Edit the recurring rule in YNAB directly' }
    );
  }

  // 1. Read current state, so omitted fields keep their values
  let current;
  try {
    const res = await apiFetch(`${API_BASE}/budgets/${budgetId}/transactions/${ynabId}`);
    current = res.data.transaction;
  } catch (err) {
    fail(`Could not read the transaction before updating it: ${err.message}`);
  }

  if (current.deleted) {
    fail('That transaction has been deleted in YNAB');
  }

  // A split transaction's category lives on its subtransactions; YNAB ignores
  // category_id on the parent, so changing it would silently do nothing.
  const isSplit = Array.isArray(current.subtransactions) && current.subtransactions.length > 0;
  if (isSplit && entry.category !== undefined) {
    fail(
      'That is a split transaction — its categories live on the split lines, and YNAB ignores a category set on the parent',
      { hint: 'Edit the split in YNAB directly' }
    );
  }

  // 2. Overlay only what the caller supplied
  const changed = [];
  const update = {
    account_id: current.account_id,
    date: current.date,
    amount: current.amount,
    payee_id: current.payee_id,
    category_id: current.category_id,
    memo: current.memo,
    cleared: current.cleared,
    approved: current.approved,
    flag_color: current.flag_color
  };

  if (entry.category !== undefined && entry.category !== null) {
    try {
      const id = await resolveCategoryId(budgetId, entry.category);
      if (id !== update.category_id) changed.push('category');
      update.category_id = id;
    } catch (err) {
      fail(err.message);
    }
  }
  if (entry.payee !== undefined && entry.payee !== current.payee_name) {
    // payee_name resolves to an existing payee or creates one; clear payee_id so
    // the name is what YNAB resolves against
    update.payee_id = null;
    update.payee_name = entry.payee;
    changed.push('payee');
  }
  if (entry.memo !== undefined && entry.memo !== current.memo) {
    update.memo = entry.memo;
    changed.push('memo');
  }
  if (entry.flag !== undefined && (entry.flag || null) !== current.flag_color) {
    update.flag_color = entry.flag || null;
    changed.push('flag');
  }
  if (entry.approved !== undefined && Boolean(entry.approved) !== current.approved) {
    update.approved = Boolean(entry.approved);
    changed.push('approved');
  }
  if (entry.cleared !== undefined && entry.cleared !== current.cleared) {
    update.cleared = entry.cleared;
    changed.push('cleared');
  }

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

  // 3. Write the complete merged object
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
