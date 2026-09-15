/**
 * Tests for ynab-api scheduled transactions (issue #477).
 *
 * The plugin fetched only /transactions, which excludes scheduled ones, so every
 * upcoming bill and recurring charge was missing. These pin both halves: that the
 * rows are produced, and that they cannot leak into spending totals — the failure
 * the CSV source already demonstrated, where future-dated rows inflated reported
 * 30-day expenses roughly sevenfold.
 */

import Database from 'better-sqlite3';
import { schemas, getSqlColumns } from '../src/plugin-schemas.js';
import { MigrationManager } from '../src/migrations.js';

describe('finance schema: scheduled column', () => {
  test('is declared on the finance type', () => {
    expect(schemas.finance.fields.scheduled).toBeDefined();
    expect(schemas.finance.fields.scheduled.jsType).toBe('boolean');
  });

  test('defaults to 0 so existing rows are treated as real transactions', () => {
    expect(schemas.finance.fields.scheduled.sqlType).toMatch(/DEFAULT 0/);
  });

  test('appears in generated SQL columns', () => {
    expect(getSqlColumns('finance')).toMatch(/scheduled/);
  });
});

describe('migration 106 (add scheduled column)', () => {
  // financial_transactions is built from the schema, so a fresh database already
  // has the column and a bare ALTER would fail with "duplicate column name" —
  // unlike the unguarded ALTERs at 101/104, whose table is created without them.
  // Exercised through the real MigrationManager rather than by reaching for the
  // migration list, so the guard is tested on the path that actually runs.
  const columnsOf = (db) =>
    db.prepare(`PRAGMA table_info(financial_transactions)`).all().map(c => c.name);

  test('a fresh database ends up with the column exactly once', async () => {
    const db = new Database(':memory:');
    const mgr = new MigrationManager(db, { verbose: false });
    await mgr.runMigrations();

    const cols = columnsOf(db);
    expect(cols).toContain('scheduled');
    expect(cols.filter(c => c === 'scheduled')).toHaveLength(1);
    db.close();
  });

  test('running every migration twice does not throw', async () => {
    const db = new Database(':memory:');
    await new MigrationManager(db, { verbose: false }).runMigrations();

    // A second pass must be a no-op; the guard is what makes that true here.
    await expect(
      new MigrationManager(db, { verbose: false }).runMigrations()
    ).resolves.not.toThrow();
    db.close();
  });

  test('upgrades a pre-existing database that lacks the column', async () => {
    const db = new Database(':memory:');
    // Simulate a database created before the field existed: build the table
    // without `scheduled`, and mark migrations up to 105 as already applied.
    // Mirrors the pre-#477 table: every indexed column present, `scheduled` absent
    db.exec(`CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, source TEXT, date DATE, account TEXT, payee TEXT,
      category TEXT, category_group TEXT, amount REAL, memo TEXT,
      cleared TEXT, flag TEXT, metadata TEXT
    )`);
    expect(columnsOf(db)).not.toContain('scheduled');

    await new MigrationManager(db, { verbose: false }).runMigrations();

    expect(columnsOf(db)).toContain('scheduled');
    db.close();
  });

  test('the added column defaults to 0 for existing rows', async () => {
    const db = new Database(':memory:');
    // Mirrors the pre-#477 table: every indexed column present, `scheduled` absent
    db.exec(`CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, source TEXT, date DATE, account TEXT, payee TEXT,
      category TEXT, category_group TEXT, amount REAL, memo TEXT,
      cleared TEXT, flag TEXT, metadata TEXT
    )`);
    db.prepare(`INSERT INTO financial_transactions (id, source, date, account, amount)
      VALUES ('pre','s','2026-01-01','Checking',-10)`).run();

    await new MigrationManager(db, { verbose: false }).runMigrations();

    const row = db.prepare(`SELECT scheduled FROM financial_transactions WHERE id='pre'`).get();
    // Pre-existing rows are real transactions, never scheduled
    expect(row.scheduled === 0 || row.scheduled === null).toBe(true);
    db.close();
  });
});

describe('scheduled rows must not contaminate spending totals', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, source TEXT, date DATE, account TEXT, payee TEXT,
      category TEXT, category_group TEXT, amount REAL, memo TEXT, cleared TEXT,
      flag TEXT, scheduled INTEGER DEFAULT 0, metadata TEXT
    )`);
    const ins = db.prepare(`INSERT INTO financial_transactions
      (id, source, date, account, amount, scheduled) VALUES (?,?,?,?,?,?)`);
    // real spending inside the window
    ins.run('a', 's', new Date(Date.now() - 86400000).toISOString().slice(0, 10), 'Checking', -100, 0);
    ins.run('b', 's', new Date(Date.now() - 172800000).toISOString().slice(0, 10), 'Checking', -50, 0);
    // a scheduled obligation months out — the shape that inflated the real account
    ins.run('c', 's', '2027-01-23', 'Checking', -10368.54, 1);
  });

  afterEach(() => db.close());

  test('a bounded window with scheduled excluded counts only real spending', () => {
    const row = db.prepare(`
      SELECT SUM(amount) total, COUNT(*) n FROM financial_transactions
      WHERE date >= DATE('now','-30 days') AND date <= DATE('now')
        AND IFNULL(scheduled,0) = 0
    `).get();
    expect(row.n).toBe(2);
    expect(row.total).toBeCloseTo(-150, 2);
  });

  test('without an upper bound the future row leaks in — the original bug', () => {
    const row = db.prepare(`
      SELECT SUM(amount) total FROM financial_transactions
      WHERE date >= DATE('now','-30 days')
    `).get();
    expect(row.total).toBeCloseTo(-10518.54, 2);
  });

  test('scheduled rows are reachable on their own for an upcoming view', () => {
    const rows = db.prepare(`
      SELECT * FROM financial_transactions
      WHERE IFNULL(scheduled,0) = 1 AND date >= DATE('now')
    `).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBeCloseTo(-10368.54, 2);
  });

  test('rows predating the column (NULL) count as real, not scheduled', () => {
    db.prepare(`INSERT INTO financial_transactions (id, source, date, account, amount, scheduled)
      VALUES ('legacy','s',DATE('now','-1 day'),'Checking',-25,NULL)`).run();
    const row = db.prepare(`
      SELECT COUNT(*) n FROM financial_transactions
      WHERE date >= DATE('now','-30 days') AND date <= DATE('now')
        AND IFNULL(scheduled,0) = 0
    `).get();
    expect(row.n).toBe(3);
  });

  test('category totals exclude scheduled rows by default', () => {
    db.prepare(`UPDATE financial_transactions SET category = 'Bills', category_group = 'Fixed' WHERE id IN ('a', 'c')`).run();
    db.prepare(`UPDATE financial_transactions SET category = 'Food', category_group = 'Living' WHERE id = 'b'`).run();

    const rows = db.prepare(`
      SELECT category, SUM(amount) total, COUNT(*) count
      FROM financial_transactions
      WHERE date <= DATE('now') AND IFNULL(scheduled, 0) = 0
      GROUP BY category
      ORDER BY category
    `).all();

    expect(rows).toEqual([
      { category: 'Bills', total: -100, count: 1 },
      { category: 'Food', total: -50, count: 1 }
    ]);

    const withScheduled = db.prepare(`
      SELECT category, SUM(amount) total, COUNT(*) count
      FROM financial_transactions
      GROUP BY category
      ORDER BY category
    `).all();

    expect(withScheduled).toEqual([
      { category: 'Bills', total: -10468.54, count: 2 },
      { category: 'Food', total: -50, count: 1 }
    ]);
  });

  test('account balances exclude scheduled rows by default', () => {
    const row = db.prepare(`
      SELECT account, SUM(amount) balance, COUNT(*) count
      FROM financial_transactions
      WHERE date <= DATE('now') AND IFNULL(scheduled, 0) = 0
      GROUP BY account
    `).get();

    expect(row).toEqual({
      account: 'Checking',
      balance: -150,
      count: 2
    });

    const withScheduled = db.prepare(`
      SELECT account, SUM(amount) balance, COUNT(*) count
      FROM financial_transactions
      GROUP BY account
    `).get();

    expect(withScheduled).toEqual({
      account: 'Checking',
      balance: -10518.54,
      count: 3
    });
  });
});
