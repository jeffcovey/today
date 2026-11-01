/**
 * Finance reads (issue #686): finance_overview and uncategorized_transactions.
 *
 * Everything here reads the local cache the finance plugins sync, as
 * `bin/finance` does: `financial_transactions`, `account_balances` (through
 * getAccountList, shared with `bin/finance accounts`) and
 * `budget_allocations`. Nothing calls YNAB. Dates are compared with today in
 * the configured zone rather than SQLite's UTC DATE('now').
 */

import { jsonResult, errorResult } from '../mcp-safeguards.js';
import { getAccountList } from '../account-balances.js';
import {
  getConfiguredTimezone, clampInt, todayIn, addDays, parseJson, likeTerm,
  isMissingTable, freshen, lead, money, moneyText, toLocal,
} from './_medium-reads-helpers.js';

export const VIEWS = ['accounts', 'upcoming', 'recent', 'budget'];
export const RECENT_DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
export const UNCATEGORIZED_DEFAULT_LIMIT = 40;
export const UPCOMING_DEFAULT_LIMIT = 50;
export const BUDGET_LIST_DEFAULT_LIMIT = 10;

function filters(args, where, params, { account = true, category = true } = {}) {
  if (args.source) {
    where.push("source LIKE ? ESCAPE '\\'");
    params.push(likeTerm(args.source));
  }
  if (account && args.account) {
    where.push("account LIKE ? ESCAPE '\\'");
    params.push(likeTerm(args.account));
  }
  if (category && args.category) {
    where.push("category LIKE ? ESCAPE '\\'");
    params.push(likeTerm(args.category));
  }
}

function txRecord(r) {
  const out = {
    id: r.id,
    date: r.date,
    account: r.account,
    payee: r.payee || null,
    category: r.category || null,
    category_group: r.category_group || null,
    amount: money(r.amount),
    memo: r.memo || null,
  };
  if (r.cleared !== undefined) out.cleared = r.cleared || null;
  return out;
}

/**
 * getAccountList's per-account transaction stats cut at SQLite's UTC
 * DATE('now'). Recount them up to today in the configured zone, and rebuild
 * the partial (summed) accounts from that count.
 *
 * A name is not an account: two budgets can each have a "Checking", and a
 * CSV source can too. Stats are grouped by source and by the YNAB budget and
 * account ids the transaction metadata carries, and a group counts toward a
 * stored balance only from the same source, by account id when both sides
 * have one, otherwise by name within a compatible budget. A group that fits
 * two balances is counted toward neither; one that fits none is a partial
 * account of its own source, keyed by its account id when it has one (two
 * unmatched accounts can share a name) and by its name otherwise.
 */
function withLocalDayStats(db, accounts, source, today) {
  const meta = key => `CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.${key}') END`;
  let sql = `
    SELECT source, account, ${meta('budget_id')} AS budget_id, ${meta('account_id')} AS account_id,
           MAX(${meta('budget_name')}) AS budget_name,
           COUNT(*) AS count, SUM(amount) AS total, MAX(date) AS last_transaction
    FROM financial_transactions
    WHERE superseded_by IS NULL AND date <= ? AND IFNULL(scheduled, 0) = 0
  `;
  const params = [today];
  if (source) {
    sql += " AND source LIKE ? ESCAPE '\\'";
    params.push(likeTerm(source));
  }
  let stats;
  try {
    stats = db.prepare(`${sql} GROUP BY source, account, budget_id, account_id`).all(...params);
  } catch (error) {
    if (isMissingTable(error)) return accounts;
    throw error;
  }
  const budgetFits = (s, b) => !s.budget_id || !b.budget_id || s.budget_id === b.budget_id;
  const fits = (s, b) => s.source === b.source && budgetFits(s, b) && (s.account_id && b.account_id
    ? s.account_id === b.account_id
    : s.account === b.account);
  const stored = accounts.filter(a => !a.partial).map(a => ({ ...a, count: 0, last_transaction: null }));
  const unmatched = [];
  for (const s of stats) {
    const owners = stored.filter(b => fits(s, b));
    if (owners.length === 1) {
      const b = owners[0];
      b.count += s.count;
      if (!b.last_transaction || s.last_transaction > b.last_transaction) b.last_transaction = s.last_transaction;
    } else if (owners.length === 0) {
      unmatched.push(s);
    }
  }
  const partialByKey = new Map();
  for (const s of unmatched) {
    const key = JSON.stringify(s.account_id
      ? [s.source, s.budget_id ?? null, 'id', s.account_id]
      : [s.source, s.budget_id ?? null, 'name', s.account]);
    const p = partialByKey.get(key) || {
      account: s.account, account_id: s.account_id ?? null, balance: 0, cleared_balance: null, uncleared_balance: null,
      type: null, on_budget: null, budget_name: s.budget_name ?? null, source: s.source, as_of: null, partial: true,
      count: 0, last_transaction: null,
    };
    p.balance += s.total;
    p.count += s.count;
    if (!p.last_transaction || s.last_transaction > p.last_transaction) p.last_transaction = s.last_transaction;
    partialByKey.set(key, p);
  }
  return [...stored, ...partialByKey.values()]
    .sort((a, b) => a.account.localeCompare(b.account) || String(a.source ?? '').localeCompare(String(b.source ?? ''))
      || String(a.account_id ?? '').localeCompare(String(b.account_id ?? '')));
}

function accountsView(args, ctx, tz, today) {
  // One read transaction, so balances and their transaction stats agree.
  let accounts = ctx.db.transaction(() => withLocalDayStats(
    ctx.db, getAccountList(ctx.db, { source: args.source || null }), args.source || null, today,
  ))();
  if (args.account) {
    const needle = String(args.account).toLowerCase();
    accounts = accounts.filter(a => String(a.account).toLowerCase().includes(needle));
  }
  const rows = accounts.map(a => ({
    account: a.account,
    account_id: a.account_id ?? null,
    balance: money(a.balance),
    cleared_balance: money(a.cleared_balance),
    uncleared_balance: money(a.uncleared_balance),
    type: a.type,
    on_budget: a.on_budget === null || a.on_budget === undefined ? null : Boolean(a.on_budget),
    budget_name: a.budget_name ?? null,
    source: a.source ?? null,
    // partial: the balance is a sum of cached transactions, which cover only
    // the retention window, not a balance the source reported.
    partial: a.partial,
    as_of: a.as_of ? toLocal(a.as_of, tz).iso : null,
    transactions_cached: a.count,
    last_transaction: a.last_transaction,
  }));
  const partial = rows.filter(r => r.partial).length;
  const text = rows.length === 0
    ? 'No accounts found.'
    : `${rows.length} account(s).${partial ? ` ${partial} show only the sum of cached transactions (partial: true), not a real balance.` : ''}`;
  return { value: { view: 'accounts', total: rows.length, accounts: rows }, text };
}

function upcomingView(args, ctx, today) {
  const days = clampInt(args.days, 30, 1, 366);
  const limit = clampInt(args.limit, UPCOMING_DEFAULT_LIMIT, 1, MAX_LIMIT);
  const until = addDays(today, days);
  const where = ['IFNULL(scheduled, 0) = 1', 'superseded_by IS NULL', 'date >= ?', 'date <= ?'];
  const params = [today, until];
  filters(args, where, params);
  const rows = ctx.db.prepare(`
    SELECT id, date, account, payee, category, category_group, amount, memo, metadata
    FROM financial_transactions WHERE ${where.join(' AND ')}
    ORDER BY date ASC, id
  `).all(...params);
  // Totals cover every scheduled row in the window; the list is capped.
  const items = rows.slice(0, limit).map(r => ({ ...txRecord(r), frequency: parseJson(r.metadata, {}).frequency || null }));
  const total = money(rows.reduce((sum, r) => sum + Number(r.amount || 0), 0));
  const text = rows.length === 0
    ? `Nothing scheduled from ${today} through ${until}.`
    : `${rows.length} scheduled transaction(s) from ${today} through ${until}, net ${moneyText(total)}${items.length < rows.length ? `; showing the first ${items.length}` : ''}.`;
  return {
    value: {
      view: 'upcoming', from: today, to: until, days, total_count: rows.length, net_total: total,
      returned: items.length, limit, has_more: items.length < rows.length, transactions: items,
    },
    text,
  };
}

function recentView(args, ctx, today) {
  const days = clampInt(args.days, 30, 1, 366);
  const limit = clampInt(args.limit, RECENT_DEFAULT_LIMIT, 1, MAX_LIMIT);
  const from = addDays(today, -days);
  const where = ['date >= ?', 'date <= ?', 'superseded_by IS NULL', 'IFNULL(scheduled, 0) = 0'];
  const params = [from, today];
  filters(args, where, params);
  const read = ctx.db.transaction(() => {
    const totals = ctx.db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN amount > 0 AND IFNULL(transfer, 0) = 0 THEN amount ELSE 0 END) AS income,
             SUM(CASE WHEN amount < 0 AND IFNULL(transfer, 0) = 0 THEN amount ELSE 0 END) AS expenses
      FROM financial_transactions WHERE ${where.join(' AND ')}
    `).get(...params);
    const rows = ctx.db.prepare(`
      SELECT id, date, account, payee, category, category_group, amount, memo, cleared
      FROM financial_transactions WHERE ${where.join(' AND ')}
      ORDER BY date DESC, amount DESC, id LIMIT ?
    `).all(...params, limit);
    return { totals, rows };
  });
  const { totals, rows } = read();
  const transactions = rows.map(txRecord);
  const text = totals.n === 0
    ? `No transactions from ${from} through ${today}.`
    : `${totals.n} transaction(s) from ${from} through ${today}${transactions.length < totals.n ? `; showing the newest ${transactions.length}` : ''}.`;
  return {
    value: {
      view: 'recent', from, to: today, days, total: totals.n, returned: transactions.length, limit,
      has_more: transactions.length < totals.n,
      // Transfers between the user's own accounts are left out of these two.
      income: money(totals.income || 0),
      expenses: money(totals.expenses || 0),
      transactions,
    },
    text,
  };
}

function budgetView(args, ctx, today) {
  const listLimit = clampInt(args.limit, BUDGET_LIST_DEFAULT_LIMIT, 1, MAX_LIMIT);
  let month = args.month ? String(args.month) : today.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'month must be YYYY-MM' };
  const monthKey = `${month}-01`;
  const where = ['month = ?'];
  const params = [monthKey];
  if (args.source) {
    where.push("source LIKE ? ESCAPE '\\'");
    params.push(likeTerm(args.source));
  }
  const whereClause = `WHERE ${where.join(' AND ')}`;
  let rows;
  try {
    rows = ctx.db.prepare(`
      SELECT category, category_group, assigned, activity, available
      FROM budget_allocations ${whereClause}
      ORDER BY category_group, category
    `).all(...params);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    // No migration creates budget_allocations, and the ynab-finance plugin
    // writes to it without creating it, so on a database where nothing else
    // made the table there is no budget to read.
    return {
      value: { view: 'budget', month, budget_table_missing: true, category_count: 0 },
      text: `No budget data for ${month}: this database has no budget_allocations table. The ynab-finance plugin writes budgets to that table but does not create it, so its budget import fails until the table exists.`,
    };
  }
  const pct = r => (r.assigned > 0 ? Math.round((Math.abs(r.activity) / r.assigned) * 1000) / 10 : null);
  const cat = r => ({
    category: r.category || 'Uncategorized',
    category_group: r.category_group || null,
    assigned: money(r.assigned),
    activity: money(r.activity),
    available: money(r.available),
    percent_used: pct(r),
  });

  if (args.category) {
    const needle = String(args.category).toLowerCase();
    const matching = rows.filter(r => String(r.category || '').toLowerCase().includes(needle));
    const matches = matching.slice(0, listLimit).map(cat);
    const truncated = matches.length < matching.length;
    const text = matching.length === 0
      ? `No budget category for ${month} matches "${args.category}".`
      : `${matching.length} budget categor${matching.length === 1 ? 'y' : 'ies'} for ${month} match "${args.category}"${truncated ? `; showing the first ${matches.length} (raise limit, up to ${MAX_LIMIT}, for the rest)` : ''}.`;
    return {
      value: {
        view: 'budget', month, category_count: matching.length, returned: matches.length, list_limit: listLimit,
        truncated, categories: matches,
      },
      text,
    };
  }

  const totals = rows.reduce((acc, r) => {
    acc.assigned += r.assigned || 0;
    acc.activity += r.activity || 0;
    acc.available += r.available || 0;
    return acc;
  }, { assigned: 0, activity: 0, available: 0 });
  // Overspent is a negative available, whether or not anything was assigned;
  // with nothing assigned there is no percent, so those lead, most negative first.
  const overAll = rows.filter(r => r.available < 0)
    .sort((a, b) => {
      const pa = pct(a);
      const pb = pct(b);
      if ((pa === null) !== (pb === null)) return pa === null ? -1 : 1;
      return (pb ?? 0) - (pa ?? 0) || a.available - b.available;
    });
  const underAll = rows.filter(r => r.assigned > 0 && r.available > 0 && r.activity !== 0)
    .sort((a, b) => b.available - a.available);
  const over = overAll.slice(0, listLimit).map(cat);
  const under = underAll.slice(0, listLimit).map(cat);
  const groups = new Map();
  for (const r of rows) {
    const key = r.category_group || 'Uncategorized';
    const g = groups.get(key) || { category_group: key, assigned: 0, activity: 0, available: 0 };
    g.assigned += r.assigned || 0;
    g.activity += r.activity || 0;
    g.available += r.available || 0;
    groups.set(key, g);
  }
  const byGroup = [...groups.values()]
    .filter(g => g.assigned !== 0 || g.activity !== 0 || g.available !== 0)
    .sort((a, b) => b.assigned - a.assigned)
    .map(g => ({ category_group: g.category_group, assigned: money(g.assigned), activity: money(g.activity), available: money(g.available) }));
  const overspent = overAll.length;
  const cut = [
    over.length < overAll.length ? `${over.length} of ${overAll.length} over budget` : null,
    under.length < underAll.length ? `${under.length} of ${underAll.length} under budget` : null,
  ].filter(Boolean);
  const text = rows.length === 0
    ? `No budget data for ${month}. Budgets come from the ynab-finance plugin's sync.`
    : `Budget for ${month}: ${rows.length} categories, ${overspent} overspent.${cut.length ? ` Showing ${cut.join(' and ')} (raise limit, up to ${MAX_LIMIT}, for the rest).` : ''}`;
  return {
    value: {
      view: 'budget',
      month,
      category_count: rows.length,
      totals: { assigned: money(totals.assigned), activity: money(totals.activity), available: money(totals.available) },
      list_limit: listLimit,
      over_budget_count: overAll.length,
      over_budget_truncated: over.length < overAll.length,
      over_budget: over,
      under_budget_count: underAll.length,
      under_budget_truncated: under.length < underAll.length,
      under_budget: under,
      by_group: byGroup,
    },
    text,
  };
}

export async function financeOverview(args, ctx) {
  const view = args.view;
  if (!VIEWS.includes(view)) return errorResult(`view must be one of ${VIEWS.join(', ')}`);
  const tz = getConfiguredTimezone();
  const today = todayIn(tz, ctx.now ?? new Date());
  const note = await freshen(ctx, 'finance', 'finance');

  let out;
  try {
    if (view === 'accounts') out = accountsView(args, ctx, tz, today);
    else if (view === 'upcoming') out = upcomingView(args, ctx, today);
    else if (view === 'recent') out = recentView(args, ctx, today);
    else out = budgetView(args, ctx, today);
  } catch (error) {
    if (isMissingTable(error)) {
      return jsonResult({ user_timezone: tz, view }, lead(`No ${view === 'budget' ? 'budget' : 'finance'} data has been synced yet.`, note));
    }
    throw error;
  }
  if (out.error) return errorResult(out.error);
  return jsonResult({ user_timezone: tz, today, ...out.value }, lead(out.text, note));
}

export async function uncategorizedTransactions(args, ctx) {
  const tz = getConfiguredTimezone();
  const today = todayIn(tz, ctx.now ?? new Date());
  const days = clampInt(args.days, 60, 1, 366);
  const limit = clampInt(args.limit, UNCATEGORIZED_DEFAULT_LIMIT, 1, MAX_LIMIT);
  const from = addDays(today, -days);
  const note = await freshen(ctx, 'finance', 'finance');

  // As in bin/finance uncategorized: only rows that can be fixed, so not
  // superseded duplicates, scheduled rules or transfers.
  const where = [
    'superseded_by IS NULL',
    'IFNULL(scheduled, 0) = 0',
    'IFNULL(transfer, 0) = 0',
    'date >= ?',
    'date <= ?',
    "(category IS NULL OR category = '' OR LOWER(category) = 'uncategorized')",
  ];
  const params = [from, today];
  filters(args, where, params, { category: false });

  let total;
  let rows;
  try {
    // One read transaction, as in recentView, so the total and the page agree.
    ({ total, rows } = ctx.db.transaction(() => ({
      total: ctx.db.prepare(`SELECT COUNT(*) AS n FROM financial_transactions WHERE ${where.join(' AND ')}`).get(...params).n,
      rows: ctx.db.prepare(`
        SELECT id, date, account, payee, amount, memo, metadata
        FROM financial_transactions WHERE ${where.join(' AND ')}
        ORDER BY date DESC, id LIMIT ?
      `).all(...params, limit),
    }))());
  } catch (error) {
    if (isMissingTable(error)) return jsonResult({ user_timezone: tz, total: 0, transactions: [] }, lead('No finance data has been synced yet.', note));
    throw error;
  }
  const transactions = rows.map(r => {
    const meta = parseJson(r.metadata, {});
    return {
      id: r.id,
      date: r.date,
      account: r.account,
      payee: r.payee || null,
      amount: money(r.amount),
      memo: r.memo || null,
      // Whether bin/finance categorize can write this one back to YNAB.
      writable: Boolean(meta.budget_id && meta.ynab_id),
    };
  });
  const text = total === 0
    ? `No uncategorized transactions from ${from} through ${today}.`
    : `${total} uncategorized transaction(s) from ${from} through ${today}${transactions.length < total ? `; showing the newest ${transactions.length}` : ''}.`;
  return jsonResult({
    user_timezone: tz, from, to: today, days, total, returned: transactions.length, limit,
    has_more: transactions.length < total, transactions,
  }, lead(text, note));
}

export const tools = [
  {
    name: 'finance_overview',
    kind: 'read',
    pluginType: 'finance',
    description: 'Finances from the local cache (like bin/finance): view accounts (balances), upcoming (scheduled bills and income ahead), recent (transactions) or budget (a month\'s over/under summary). Reads only; nothing is sent to YNAB.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: VIEWS, description: 'Which view.' },
        days: { type: 'number', description: 'upcoming: days ahead (default 30). recent: days back (default 30). Max 366.' },
        limit: { type: 'number', description: `recent and upcoming: max transactions (default ${RECENT_DEFAULT_LIMIT} recent, ${UPCOMING_DEFAULT_LIMIT} upcoming). budget: max categories in each of the over and under lists, or in the category matches (default ${BUDGET_LIST_DEFAULT_LIMIT}). Max ${MAX_LIMIT}.` },
        month: { type: 'string', description: 'budget: YYYY-MM, default this month.' },
        account: { type: 'string', description: 'accounts, upcoming, recent: account name contains this.' },
        category: { type: 'string', description: 'upcoming, recent, budget: category name contains this.' },
        source: { type: 'string', description: 'Only this finance source (name contains this).' },
      },
      required: ['view'],
    },
    handler: financeOverview,
  },
  {
    name: 'uncategorized_transactions',
    kind: 'read',
    pluginType: 'finance',
    description: 'Transactions that still need a category (like bin/finance uncategorized), newest first, with ids and whether each can be written back to YNAB.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days back (default 60, max 366).' },
        limit: { type: 'number', description: `Max transactions (default ${UNCATEGORIZED_DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        account: { type: 'string', description: 'Account name contains this.' },
        source: { type: 'string', description: 'Only this finance source (name contains this).' },
      },
    },
    handler: uncategorizedTransactions,
  },
];
