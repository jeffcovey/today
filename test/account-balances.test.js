import Database from 'better-sqlite3';
import {
  convertYnabAccount,
  replaceBudgetBalances,
  removeBudgetBalances,
  getAccountList
} from '../src/account-balances.js';
import { MigrationManager } from '../src/migrations.js';

function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

describe('account balances (issue #608)', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    await new MigrationManager(db, { verbose: false }).runMigrations();
  });

  afterEach(() => db.close());

  function addTx(id, account, amount, fields = {}) {
    db.prepare(`
      INSERT INTO financial_transactions (id, source, date, account, amount, scheduled, superseded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, fields.source ?? 'ynab-api/default', fields.date ?? today(-5), account, amount,
      fields.scheduled ? 1 : 0, fields.superseded_by ?? null
    );
  }

  const asOf = '2026-10-15T12:00:00.000Z';
  const ynab = (id, name, balance, extra = {}) =>
    convertYnabAccount({ id, name, type: 'checking', on_budget: true, balance, cleared_balance: balance, ...extra }, 'b1', 'Budget', asOf);

  test('migrations create the account_balances table', () => {
    const cols = db.prepare('PRAGMA table_info(account_balances)').all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'source', 'account', 'balance', 'cleared_balance', 'as_of']));
  });

  test('convertYnabAccount converts milliunits and skips closed or deleted accounts', () => {
    const row = ynab('a1', 'Chase Sapphire Reserve', -19165920, { cleared_balance: -18000500 });
    expect(row.balance).toBeCloseTo(-19165.92);
    expect(row.cleared_balance).toBeCloseTo(-18000.5);
    expect(row.id).toBe('b1:a1');
    expect(ynab('a2', 'Closed', 0, { closed: true })).toBeNull();
    expect(ynab('a3', 'Deleted', 0, { deleted: true })).toBeNull();
  });

  test('a stored balance wins over the transaction sum', () => {
    addTx('t1', 'Chase Sapphire Reserve', -11697.14);
    replaceBudgetBalances(db, 'ynab-api/default', 'b1', [ynab('a1', 'Chase Sapphire Reserve', -19165920)]);

    const [acc] = getAccountList(db);
    expect(acc.account).toBe('Chase Sapphire Reserve');
    expect(acc.balance).toBeCloseTo(-19165.92);
    expect(acc.partial).toBe(false);
    expect(acc.count).toBe(1);
    expect(acc.as_of).toBe(asOf);
  });

  test('accounts with a balance but no cached transactions are listed', () => {
    replaceBudgetBalances(db, 'ynab-api/default', 'b1', [ynab('a1', 'Charles Schwab Checking', 500000)]);
    const [acc] = getAccountList(db);
    expect(acc.account).toBe('Charles Schwab Checking');
    expect(acc.balance).toBeCloseTo(500);
    expect(acc.count).toBe(0);
  });

  test('accounts without a stored balance fall back to a partial transaction sum', () => {
    addTx('t1', 'CSV Card', -20, { source: 'ynab-finance/default' });
    addTx('t2', 'CSV Card', -5, { source: 'ynab-finance/default' });
    addTx('t3', 'CSV Card', -100, { source: 'ynab-finance/default', superseded_by: 'x' });
    addTx('t4', 'CSV Card', -7, { source: 'ynab-finance/default', scheduled: true, date: today(10) });

    const [acc] = getAccountList(db);
    expect(acc.partial).toBe(true);
    expect(acc.balance).toBeCloseTo(-25);
    expect(acc.count).toBe(2);

    const [withScheduled] = getAccountList(db, { scheduled: true });
    expect(withScheduled.balance).toBeCloseTo(-32);
  });

  test('--scheduled reports upcoming rows beside a stored balance without changing it', () => {
    addTx('t1', 'Checking', -10);
    addTx('t2', 'Checking', -50, { scheduled: true, date: today(3) });
    replaceBudgetBalances(db, 'ynab-api/default', 'b1', [ynab('a1', 'Checking', 1000000)]);

    const [acc] = getAccountList(db, { scheduled: true });
    expect(acc.balance).toBeCloseTo(1000);
    expect(acc.upcoming.total).toBeCloseTo(-50);
    expect(acc.upcoming.count).toBe(1);
  });

  test('source filter applies to balances and transactions', () => {
    addTx('t1', 'CSV Card', -20, { source: 'ynab-finance/default' });
    replaceBudgetBalances(db, 'ynab-api/default', 'b1', [ynab('a1', 'Checking', 1000)]);

    expect(getAccountList(db, { source: 'ynab-api' }).map(a => a.account)).toEqual(['Checking']);
    expect(getAccountList(db, { source: 'ynab-finance' }).map(a => a.account)).toEqual(['CSV Card']);
  });

  test('replace swaps a budget snapshot; remove drops a budget', () => {
    replaceBudgetBalances(db, 'ynab-api/default', 'b1', [ynab('a1', 'Checking', 1000), ynab('a2', 'Savings', 2000)]);
    replaceBudgetBalances(db, 'ynab-api/default', 'b1', [ynab('a1', 'Checking', 3000)]);
    expect(getAccountList(db).map(a => [a.account, a.balance])).toEqual([['Checking', 3]]);

    expect(removeBudgetBalances(db, 'ynab-api/default', ['b1'])).toBe(1);
    expect(getAccountList(db)).toEqual([]);
  });
});
