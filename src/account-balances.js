// Account balances reported by a finance source (issue #608).
//
// financial_transactions holds only a retention window of history, so summing it
// does not give an account's balance. Sources that know the real balance (the
// YNAB API's /accounts endpoint) store it here on every sync, and
// `bin/finance accounts` prefers it over the transaction sum.
//
// Like every table, this is a cache: each sync replaces a budget's rows wholesale.

export const ACCOUNT_BALANCES_TABLE = 'account_balances';

export const ACCOUNT_BALANCES_DDL = `
  CREATE TABLE IF NOT EXISTS account_balances (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    budget_id TEXT,
    budget_name TEXT,
    account_id TEXT,
    account TEXT NOT NULL,
    type TEXT,
    on_budget INTEGER,
    balance REAL NOT NULL,
    cleared_balance REAL,
    uncleared_balance REAL,
    as_of DATETIME NOT NULL,
    metadata TEXT
  )
`;

export function ensureAccountBalancesTable(db) {
  db.exec(ACCOUNT_BALANCES_DDL);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_account_balances_source ON account_balances(source)`);
}

/**
 * Replace every balance row for one budget of one source.
 * `accounts` are already-converted rows (see convertYnabAccount).
 */
export function replaceBudgetBalances(db, source, budgetId, accounts) {
  ensureAccountBalancesTable(db);
  const del = db.prepare('DELETE FROM account_balances WHERE source = ? AND budget_id = ?');
  const insert = db.prepare(`
    INSERT OR REPLACE INTO account_balances
      (id, source, budget_id, budget_name, account_id, account, type, on_budget,
       balance, cleared_balance, uncleared_balance, as_of, metadata)
    VALUES
      (@id, @source, @budget_id, @budget_name, @account_id, @account, @type, @on_budget,
       @balance, @cleared_balance, @uncleared_balance, @as_of, @metadata)
  `);
  db.transaction(() => {
    del.run(source, budgetId);
    for (const acc of accounts) insert.run({ ...acc, source, budget_id: budgetId });
  })();
}

/**
 * Remove balance rows for budgets a source no longer syncs. Returns rows removed.
 */
export function removeBudgetBalances(db, source, budgetIds) {
  if (budgetIds.length === 0) return 0;
  ensureAccountBalancesTable(db);
  const del = db.prepare('DELETE FROM account_balances WHERE source = ? AND budget_id = ?');
  let removed = 0;
  db.transaction(() => {
    for (const id of budgetIds) removed += del.run(source, id).changes;
  })();
  return removed;
}

/**
 * Convert a YNAB API account (GET /budgets/{id}/accounts) into a balance row.
 * Returns null for closed or deleted accounts, which carry no live balance.
 */
export function convertYnabAccount(acc, budgetId, budgetName, asOf) {
  if (!acc || acc.deleted || acc.closed) return null;
  return {
    id: `${budgetId}:${acc.id}`,
    budget_name: budgetName,
    account_id: acc.id,
    account: acc.name || '',
    type: acc.type || null,
    on_budget: acc.on_budget ? 1 : 0,
    // YNAB amounts are milliunits
    balance: (acc.balance ?? 0) / 1000,
    cleared_balance: acc.cleared_balance != null ? acc.cleared_balance / 1000 : null,
    uncleared_balance: acc.uncleared_balance != null ? acc.uncleared_balance / 1000 : null,
    as_of: asOf,
    metadata: JSON.stringify({
      last_reconciled_at: acc.last_reconciled_at || null,
      direct_import_linked: acc.direct_import_linked ?? null,
      direct_import_in_error: acc.direct_import_in_error ?? null
    })
  };
}

function tableExists(db, name) {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(name));
}

/**
 * Build the account list `bin/finance accounts` shows.
 *
 * Accounts with a stored balance use it. Any other account that appears in
 * financial_transactions falls back to the sum of the cached transactions and is
 * marked `partial: true`, because that sum only covers the retained window.
 *
 * Options: source (substring filter, as elsewhere in bin/finance) and
 * scheduled (include upcoming scheduled rows in the transaction stats).
 */
export function getAccountList(db, { source = null, scheduled = false } = {}) {
  const sourceLike = source ? `%${source}%` : null;

  // Per-account transaction stats from the local cache
  let txSql = `
    SELECT account, COUNT(*) AS count, SUM(amount) AS total,
           MIN(date) AS first_transaction, MAX(date) AS last_transaction
    FROM financial_transactions
    WHERE superseded_by IS NULL
  `;
  const txParams = [];
  if (!scheduled) txSql += ` AND date <= DATE('now') AND IFNULL(scheduled, 0) = 0`;
  if (sourceLike) {
    txSql += ` AND source LIKE ?`;
    txParams.push(sourceLike);
  }
  txSql += ` GROUP BY account`;
  const txStats = tableExists(db, 'financial_transactions')
    ? db.prepare(txSql).all(...txParams)
    : [];
  const statsByAccount = new Map(txStats.map(r => [r.account, r]));

  // Upcoming scheduled rows, reported alongside a real balance
  const upcomingByAccount = new Map();
  if (scheduled && tableExists(db, 'financial_transactions')) {
    let upSql = `
      SELECT account, COUNT(*) AS count, SUM(amount) AS total
      FROM financial_transactions
      WHERE superseded_by IS NULL AND (IFNULL(scheduled, 0) = 1 OR date > DATE('now'))
    `;
    const upParams = [];
    if (sourceLike) {
      upSql += ` AND source LIKE ?`;
      upParams.push(sourceLike);
    }
    upSql += ` GROUP BY account`;
    for (const r of db.prepare(upSql).all(...upParams)) upcomingByAccount.set(r.account, r);
  }

  let balances = [];
  if (tableExists(db, ACCOUNT_BALANCES_TABLE)) {
    let balSql = `SELECT * FROM account_balances`;
    const balParams = [];
    if (sourceLike) {
      balSql += ` WHERE source LIKE ?`;
      balParams.push(sourceLike);
    }
    balances = db.prepare(balSql).all(...balParams);
  }

  const result = [];
  const covered = new Set();
  for (const b of balances) {
    covered.add(b.account);
    const stats = statsByAccount.get(b.account);
    result.push({
      account: b.account,
      balance: b.balance,
      cleared_balance: b.cleared_balance,
      uncleared_balance: b.uncleared_balance,
      type: b.type,
      on_budget: b.on_budget,
      budget_name: b.budget_name,
      source: b.source,
      as_of: b.as_of,
      partial: false,
      count: stats?.count ?? 0,
      first_transaction: stats?.first_transaction ?? null,
      last_transaction: stats?.last_transaction ?? null,
      upcoming: upcomingByAccount.get(b.account) ?? null
    });
  }

  for (const s of txStats) {
    if (covered.has(s.account)) continue;
    result.push({
      account: s.account,
      balance: s.total,
      cleared_balance: null,
      uncleared_balance: null,
      type: null,
      on_budget: null,
      budget_name: null,
      source: null,
      as_of: null,
      partial: true,
      count: s.count,
      first_transaction: s.first_transaction,
      last_transaction: s.last_transaction,
      upcoming: null
    });
  }

  result.sort((a, b) => a.account.localeCompare(b.account));
  return result;
}
