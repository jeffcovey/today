/**
 * categorize_transaction: the MCP version of `bin/finance categorize <id>`.
 * It writes to YNAB, so it is destructive: the caller must name the
 * transaction's payee, and dry_run is on unless sent false (the CLI's
 * --dry-run, made the default).
 *
 * The write is the CLI's: writeEntryAndSync('finance', entry) with the row's
 * metadata, which the ynab-api plugin's write command reads, merges onto
 * the transaction's current state in YNAB and PUTs back. That command also
 * refuses a category name YNAB doesn't have; this tool checks the name
 * against the categories already in the local database first, so a dry run
 * catches a wrong name too.
 */

import { writeEntryAndSync } from '../plugin-loader.js';
import { getConfiguredTimezone } from '../date-utils.js';
import { staleNote } from '../mcp-reads.js';
import { verifyTitle, isDryRun, jsonResult, errorResult } from '../mcp-safeguards.js';
import { resolveCategoryId, assertWritable, WriteRefused } from '../../plugins/ynab-api/transaction-update.js';

export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

function parseMetadata(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
  } catch {
    return null;
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * Categories known locally for the transaction's budget, grouped the way
 * YNAB's categories endpoint returns them, so the plugin's own
 * resolveCategoryId can match and refuse ambiguous names.
 */
export function knownCategoryGroups(db, row, metadata) {
  const pairs = new Map();
  const add = (group, name) => {
    const cat = String(name || '').trim();
    if (!cat || cat.toLowerCase() === 'uncategorized') return;
    const g = String(group || '').trim() || '(no group)';
    pairs.set(`${g}\u0000${cat}`, { group: g, name: cat });
  };

  const budgetId = metadata?.budget_id || null;
  const rows = db.prepare(`
    SELECT DISTINCT category_group, category FROM financial_transactions
    WHERE source = ? AND category IS NOT NULL AND category != ''
      ${budgetId ? "AND json_extract(metadata, '$.budget_id') = ?" : ''}
  `).all(...(budgetId ? [row.source, budgetId] : [row.source]));
  for (const r of rows) add(r.category_group, r.category);

  if (tableExists(db, 'budget_allocations')) {
    for (const r of db.prepare('SELECT DISTINCT category_group, category FROM budget_allocations WHERE source = ?').all(row.source)) {
      add(r.category_group, r.category);
    }
  }

  const groups = new Map();
  for (const { group, name } of pairs.values()) {
    if (!groups.has(group)) groups.set(group, { name: group, categories: [] });
    groups.get(group).categories.push({ id: `${group}\u0000${name}`, name });
  }
  return [...groups.values()];
}

function describeTransaction(row, metadata) {
  return {
    id: row.id,
    date: row.date,
    account: row.account,
    payee: row.payee,
    amount: row.amount,
    category: row.category || null,
    category_group: row.category_group || null,
    memo: row.memo || null,
    flag: row.flag || null,
    approved: metadata?.approved ?? null,
    source: row.source,
  };
}

/**
 * Check the request and work out the entry for the plugin.
 * @returns {{entry: object, changes: object, transaction: object} | {error: string}}
 */
export function buildCategorizeEntry(db, args) {
  const id = String(args.id || '').trim();
  if (!id) return { error: 'id is required' };
  const row = db.prepare(`
    SELECT id, source, date, account, payee, category, category_group, amount, memo, cleared, flag,
           transfer, scheduled, superseded_by, metadata
    FROM financial_transactions WHERE id = ?
  `).get(id);
  if (!row) return { error: `No transaction with id ${id}. Use the uncategorized list or query_database to find it.` };

  const check = verifyTitle(args.payee, row.payee, { what: 'transaction' });
  if (!check.ok) {
    return { error: check.error.replace('title is required', 'payee is required').replace("transaction's title", "transaction's payee") };
  }

  const metadata = parseMetadata(row.metadata);
  if (metadata === null) return { error: 'The transaction\'s metadata is unreadable, so it can\'t be matched to YNAB. Nothing was changed.' };
  try {
    assertWritable(metadata, {});
  } catch (error) {
    if (error instanceof WriteRefused) return { error: `${error.message}${error.hint ? ` (${error.hint})` : ''}. Nothing was changed.` };
    throw error;
  }
  if (row.superseded_by) {
    return { error: `This row is a duplicate kept for audit; the transaction is ${row.superseded_by}. Categorize that one. Nothing was changed.` };
  }

  const entry = { metadata: row.metadata };
  const changes = {};

  if (args.category !== undefined && args.category !== null && args.category !== '') {
    if (row.transfer) return { error: 'This is a transfer between your own accounts, which YNAB leaves uncategorized. Nothing was changed.' };
    let resolved;
    try {
      resolved = resolveCategoryId(knownCategoryGroups(db, row, metadata), args.category);
    } catch (error) {
      if (error instanceof WriteRefused) {
        return { error: `${error.message.replace('No category matching', 'Unknown category')}. Nothing was changed.` };
      }
      throw error;
    }
    const [group, name] = resolved.split('\u0000');
    entry.category = group === '(no group)' ? name : `${group}: ${name}`;
    const current = row.category ? (row.category_group ? `${row.category_group}: ${row.category}` : row.category) : null;
    if (current !== entry.category) changes.category = { from: current, to: entry.category };
  }

  if (args.memo !== undefined && args.memo !== null) {
    const memo = String(args.memo);
    entry.memo = memo;
    if ((row.memo || '') !== memo) changes.memo = { from: row.memo || null, to: memo || null };
  }

  if (args.flag !== undefined && args.flag !== null) {
    const flag = String(args.flag).trim().toLowerCase();
    if (flag && !FLAG_COLORS.includes(flag)) return { error: `flag must be one of ${FLAG_COLORS.join(', ')}, or "" to clear it` };
    entry.flag = flag;
    if ((row.flag || '') !== flag) changes.flag = { from: row.flag || null, to: flag || null };
  }

  if (args.approve !== undefined && args.approve !== null) {
    if (typeof args.approve !== 'boolean') return { error: 'approve must be true (approve) or false (unapprove)' };
    entry.approved = args.approve;
    if (metadata.approved !== args.approve) changes.approved = { from: metadata.approved ?? null, to: args.approve };
  }

  if (!('category' in entry) && !('memo' in entry) && !('flag' in entry) && !('approved' in entry)) {
    return { error: 'Nothing to change: pass category, memo, flag or approve' };
  }
  return { entry, changes, transaction: describeTransaction(row, metadata), row };
}

async function categorizeTransaction(args, ctx) {
  const { db } = ctx;
  const sync = ctx.syncForRead ? await ctx.syncForRead(db, 'finance') : null;
  const note = staleNote('finance', sync);
  const tz = getConfiguredTimezone();

  const built = buildCategorizeEntry(db, args);
  if (built.error) return errorResult(built.error);
  const { entry, changes, transaction, row } = built;
  const summary = Object.keys(changes).length
    ? Object.entries(changes).map(([k, v]) => `${k} → ${v.to ?? '(none)'}`).join(', ')
    : 'no change (already in that state)';

  if (isDryRun(args)) {
    return jsonResult({ dry_run: true, transaction, changes, user_timezone: tz },
      [note, `Dry run: nothing was sent to YNAB. Would set ${summary} on ${row.date} ${row.payee} (${row.amount}). ` +
        'Call again with dry_run: false to apply.'].filter(Boolean).join('\n'));
  }

  const write = ctx.writeEntryAndSync || writeEntryAndSync;
  const result = await write('finance', entry, { db, sourceFilter: row.source });
  if (!result.success) {
    const hint = result.writeResult?.hint ? ` (${result.writeResult.hint})` : '';
    return errorResult(result.partialSuccess
      ? `YNAB was updated, but the local copy did not refresh: ${result.error}`
      : `${result.error}${hint}. Nothing was changed.`);
  }
  if (result.writeResult?.unchanged) {
    return jsonResult({ dry_run: false, transaction, changes: {}, user_timezone: tz },
      result.writeResult.message || 'Already in the requested state; nothing sent to YNAB.');
  }

  return jsonResult({
    dry_run: false,
    transaction: result.writeResult?.entry || transaction,
    updated_fields: result.writeResult?.updated_fields || Object.keys(changes),
    changes,
    user_timezone: tz,
  }, `Updated in YNAB: ${summary} on ${row.date} ${row.payee}.`);
}

export const tools = [
  {
    name: 'categorize_transaction',
    kind: 'destructive',
    pluginType: 'finance',
    description: 'Set a transaction\'s category, memo, flag or approval, writing it back to YNAB (like `bin/finance categorize`). ' +
      'Requires the transaction\'s payee to confirm which one. dry_run is on by default and shows the change without sending it; ' +
      'send dry_run: false to apply. category is a name, optionally "Group: Category"; unknown or ambiguous names are refused. ' +
      'Only transactions synced from the YNAB API can be written.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The transaction\'s id from the database' },
        payee: { type: 'string', description: 'The transaction\'s payee (or a distinctive part), to confirm which transaction this is' },
        category: { type: 'string', description: 'Category name, optionally "Group: Category"' },
        memo: { type: 'string', description: 'New memo; "" clears it' },
        flag: { type: 'string', description: `Flag colour: ${FLAG_COLORS.join(', ')}, or "" to clear` },
        approve: { type: 'boolean', description: 'true to approve, false to unapprove' },
        dry_run: { type: 'boolean', description: 'Default true: show what would be sent and send nothing. Send false to apply.' },
      },
      required: ['id', 'payee'],
    },
    handler: categorizeTransaction,
  },
];
