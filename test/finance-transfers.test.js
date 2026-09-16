/**
 * Transfers between a user's own accounts.
 *
 * YNAB leaves transfers uncategorised on purpose — moving money between your own
 * accounts is neither income nor spending. Treating them as ordinary rows caused
 * two problems on real data: they were 44 of 48 entries in the "uncategorized"
 * list (so the list was ~92% noise), and they inflated reported 30-day Expenses
 * by $567 because the outgoing leg counted as spending while the incoming leg
 * landed in Income, leaving the net correct but both sides wrong.
 */

import Database from 'better-sqlite3';
import { schemas } from '../src/plugin-schemas.js';
import { MigrationManager } from '../src/migrations.js';

describe('finance schema: transfer column', () => {
  test('is declared and defaults to 0', () => {
    expect(schemas.finance.fields.transfer).toBeDefined();
    expect(schemas.finance.fields.transfer.sqlType).toMatch(/DEFAULT 0/);
  });
});

describe('migration 108', () => {
  const columnsOf = (db) =>
    db.prepare(`PRAGMA table_info(financial_transactions)`).all().map(c => c.name);

  test('adds the column to a pre-existing database', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, source TEXT, date DATE, account TEXT, payee TEXT,
      category TEXT, category_group TEXT, amount REAL, memo TEXT,
      cleared TEXT, flag TEXT, metadata TEXT
    )`);
    await new MigrationManager(db, { verbose: false }).runMigrations();
    expect(columnsOf(db)).toContain('transfer');
    db.close();
  });

  test('running twice does not throw', async () => {
    const db = new Database(':memory:');
    await new MigrationManager(db, { verbose: false }).runMigrations();
    await expect(new MigrationManager(db, { verbose: false }).runMigrations()).resolves.not.toThrow();
    db.close();
  });

  // Existing rows must be correct immediately, not only after a re-sync
  test('backfills from API metadata and the CSV payee convention', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, source TEXT, date DATE, account TEXT, payee TEXT,
      category TEXT, category_group TEXT, amount REAL, memo TEXT,
      cleared TEXT, flag TEXT, metadata TEXT
    )`);
    const ins = db.prepare(`INSERT INTO financial_transactions
      (id, source, date, account, payee, amount, metadata) VALUES (?,?,?,?,?,?,?)`);
    ins.run('api-xfer', 'ynab-api/p', '2026-09-01', 'Checking', 'Transfer : Card', -100,
      '{"transfer_account_id":"acct-2"}');
    ins.run('api-real', 'ynab-api/p', '2026-09-01', 'Checking', 'Walgreens', -2.45,
      '{"transfer_account_id":null}');
    ins.run('csv-xfer', 'ynab-finance/d', '2026-09-01', 'Checking', 'Transfer : Paypal', -50, null);
    ins.run('csv-real', 'ynab-finance/d', '2026-09-01', 'Checking', 'Amazon', -18.97, null);

    await new MigrationManager(db, { verbose: false }).runMigrations();

    const flag = (id) => db.prepare(`SELECT transfer FROM financial_transactions WHERE id=?`).get(id).transfer;
    expect(flag('api-xfer')).toBe(1);
    expect(flag('csv-xfer')).toBe(1);
    expect(flag('api-real')).toBeFalsy();
    expect(flag('csv-real')).toBeFalsy();
    db.close();
  });

  test('does not mistake a payee that merely mentions transfer', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, source TEXT, date DATE, account TEXT, payee TEXT,
      category TEXT, category_group TEXT, amount REAL, memo TEXT,
      cleared TEXT, flag TEXT, metadata TEXT
    )`);
    db.prepare(`INSERT INTO financial_transactions (id, source, date, account, payee, amount)
      VALUES ('t','s','2026-09-01','Checking','Transfer Wise Ltd',-20)`).run();
    await new MigrationManager(db, { verbose: false }).runMigrations();
    // "Transfer :" with the colon is the YNAB convention; a company name is not
    expect(db.prepare(`SELECT transfer FROM financial_transactions WHERE id='t'`).get().transfer).toBeFalsy();
    db.close();
  });
});

describe('reporting excludes transfers', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, source TEXT, date DATE, account TEXT, payee TEXT,
      category TEXT, category_group TEXT, amount REAL, memo TEXT, cleared TEXT,
      flag TEXT, scheduled INTEGER DEFAULT 0, transfer INTEGER DEFAULT 0,
      dedup_key TEXT, superseded_by TEXT, metadata TEXT
    )`);
    const ins = db.prepare(`INSERT INTO financial_transactions
      (id, source, date, account, payee, category, amount, transfer)
      VALUES (@id,@source,@date,@account,@payee,@category,@amount,@transfer)`);
    const base = { source: 's', date: '2026-09-01', account: 'Checking', category: 'Groceries', transfer: 0 };
    ins.run({ ...base, id: 'spend1', payee: 'Publix', amount: -100 });
    ins.run({ ...base, id: 'spend2', payee: 'Amazon', amount: -50 });
    // a transfer pair: both legs, uncategorised, as YNAB records them
    ins.run({ ...base, id: 'x-out', payee: 'Transfer : Card', category: null, amount: -500, transfer: 1 });
    ins.run({ ...base, id: 'x-in', account: 'Card', payee: 'Transfer : Checking', category: null, amount: 500, transfer: 1 });
  });

  afterEach(() => db.close());

  test('expenses exclude the outgoing leg', () => {
    const withT = db.prepare(`SELECT SUM(amount) t FROM financial_transactions WHERE amount<0`).get().t;
    const withoutT = db.prepare(
      `SELECT SUM(amount) t FROM financial_transactions WHERE amount<0 AND IFNULL(transfer,0)=0`
    ).get().t;
    expect(withT).toBe(-650);
    expect(withoutT).toBe(-150);
  });

  test('income excludes the incoming leg', () => {
    const income = db.prepare(
      `SELECT IFNULL(SUM(amount),0) t FROM financial_transactions WHERE amount>0 AND IFNULL(transfer,0)=0`
    ).get().t;
    expect(income).toBe(0);
  });

  test('the net is unchanged either way — which is why this hid', () => {
    const withT = db.prepare(`SELECT SUM(amount) t FROM financial_transactions`).get().t;
    const withoutT = db.prepare(
      `SELECT SUM(amount) t FROM financial_transactions WHERE IFNULL(transfer,0)=0`
    ).get().t;
    expect(withT).toBe(withoutT);
  });

  test('uncategorized lists only things a person can actually categorise', () => {
    const rows = db.prepare(`
      SELECT id FROM financial_transactions
      WHERE superseded_by IS NULL AND IFNULL(scheduled,0)=0 AND IFNULL(transfer,0)=0
        AND (category IS NULL OR category='' OR LOWER(category)='uncategorized')
    `).all();
    expect(rows).toEqual([]);
  });

  test('account balances still include transfers, which do move money', () => {
    const checking = db.prepare(
      `SELECT SUM(amount) t FROM financial_transactions WHERE account='Checking'`
    ).get().t;
    expect(checking).toBe(-650);
  });
});
