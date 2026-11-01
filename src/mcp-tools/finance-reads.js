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
  isMissingTable, freshen, lead, money, toLocal,
} from './_medium-reads-helpers.js';

export const VIEWS = ['accounts', 'upcoming', 'recent', 'budget'];
export const RECENT_DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
export const UNCATEGORIZED_DEFAULT_LIMIT = 40;

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

function accountsView(args, ctx, tz) {
  let accounts = getAccountList(ctx.db, { source: args.source || null });
  if (args.account) {
    const needle = String(args.account).toLowerCase();
    accounts = accounts.filter(a => String(a.account).toLowerCase().includes(needle));
  }
  const rows = accounts.map(a => ({
    account: a.account,
    balance: money(a.balance),
    cleared_balance: money(a.cleared_balance),
    uncleared_balance: money(a.uncleared_balance),
    type: a.type,
    on_budget: a.on_budget === null ? null : Boolean(a.on_budget),
    budget_name: a.budget_name,
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
  const until = addDays(today, days);
  const where = ['IFNULL(scheduled, 0) = 1', 'superseded_by IS NULL', 'date >= ?', 'date <= ?'];
  const params = [today, until];
  filters(args, where, params);
  const rows = ctx.db.prepare(`
    SELECT id, date, account, payee, category, category_group, amount, memo, metadata
    FROM financial_transactions WHERE ${where.join(' AND ')}
    ORDER BY date ASC, id
  `).all(...params);
  const items = rows.map(r => ({ ...txRecord(r), frequency: parseJson(r.metadata, {}).frequency || null }));
  const total = money(rows.reduce((sum, r) => sum + Number(r.amount || 0), 0));
  const text = items.length === 0
    ? `Nothing scheduled from ${today} through ${until}.`
    : `${items.length} scheduled transaction(s) from ${today} through ${until}, net ${total}.`;
  return { value: { view: 'upcoming', from: today, to: until, days, total_count: items.length, net_total: total, transactions: items }, text };
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
  const rows = ctx.db.prepare(`
    SELECT category, category_group, assigned, activity, available
    FROM budget_allocations ${whereClause}
    ORDER BY category_group, category
  `).all(...params);
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
    const matches = rows.filter(r => String(r.category || '').toLowerCase().includes(needle)).map(cat);
    const text = matches.length === 0
      ? `No budget category for ${month} matches "${args.category}".`
      : `${matches.length} budget categor${matches.length === 1 ? 'y' : 'ies'} for ${month} match "${args.category}".`;
    return { value: { view: 'budget', month, categories: matches }, text };
  }

  const totals = rows.reduce((acc, r) => {
    acc.assigned += r.assigned || 0;
    acc.activity += r.activity || 0;
    acc.available += r.available || 0;
    return acc;
  }, { assigned: 0, activity: 0, available: 0 });
  const over = rows.filter(r => r.assigned > 0 && r.available < 0)
    .sort((a, b) => (pct(b) ?? 0) - (pct(a) ?? 0)).slice(0, 10).map(cat);
  const under = rows.filter(r => r.assigned > 0 && r.available > 0 && r.activity !== 0)
    .sort((a, b) => b.available - a.available).slice(0, 10).map(cat);
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
  const overspent = rows.filter(r => r.available < 0).length;
  const text = rows.length === 0
    ? `No budget data for ${month}. Budgets come from the ynab-finance plugin's sync.`
    : `Budget for ${month}: ${rows.length} categories, ${overspent} overspent.`;
  return {
    value: {
      view: 'budget',
      month,
      category_count: rows.length,
      totals: { assigned: money(totals.assigned), activity: money(totals.activity), available: money(totals.available) },
      over_budget: over,
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
    if (view === 'accounts') out = accountsView(args, ctx, tz);
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
    total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM financial_transactions WHERE ${where.join(' AND ')}`).get(...params).n;
    rows = ctx.db.prepare(`
      SELECT id, date, account, payee, amount, memo, metadata
      FROM financial_transactions WHERE ${where.join(' AND ')}
      ORDER BY date DESC, id LIMIT ?
    `).all(...params, limit);
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
        limit: { type: 'number', description: `recent: max transactions (default ${RECENT_DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
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
