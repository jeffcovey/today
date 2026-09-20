/**
 * Cross-source reconciliation (issue #479).
 *
 * The CSV export and the API hold the same transactions with no shared ID —
 * YNAB's Register.csv has no ID column — so every unfiltered query double-counts.
 * These pin the three rules and, importantly, that nothing is deleted.
 */

import Database from 'better-sqlite3';
import {
  buildDedupKey,
  recomputeDedupKeys,
  getSourcePrecedence,
  reconcileFinanceSources
} from '../src/finance-reconcile.js';

const API = 'ynab-api/personal';
const CSV = 'ynab-finance/default';

const CONFIG = {};
const PLUGINS = new Map([
  ['ynab-api', { settings: { precedence: { default: 100 } } }],
  ['ynab-finance', { settings: { precedence: { default: 50 } } }]
]);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE financial_transactions (
    id TEXT PRIMARY KEY, source TEXT, date DATE, account TEXT, payee TEXT,
    category TEXT, category_group TEXT, amount REAL, memo TEXT, cleared TEXT,
    flag TEXT, scheduled INTEGER DEFAULT 0, dedup_key TEXT, superseded_by TEXT,
    metadata TEXT
  )`);
  return db;
}

function insert(db, rows) {
  const stmt = db.prepare(`INSERT INTO financial_transactions
    (id, source, date, account, payee, amount, category, scheduled, metadata)
    VALUES (@id, @source, @date, @account, @payee, @amount, @category, @scheduled, @metadata)`);
  for (const r of rows) {
    stmt.run({ category: null, scheduled: 0, payee: null, metadata: null, ...r });
  }
}

const live = (db, source) => db.prepare(
  `SELECT COUNT(*) n FROM financial_transactions WHERE source = ? AND superseded_by IS NULL`
).get(source).n;

describe('buildDedupKey', () => {
  test('normalises case and whitespace so sources formatted differently still match', () => {
    const a = buildDedupKey({ account: 'Chase Checking', date: '2026-01-05', amount: -12.34, payee: 'Disney+' });
    const b = buildDedupKey({ account: '  chase checking ', date: '2026-01-05', amount: -12.34, payee: ' DISNEY+ ' });
    expect(a).toBe(b);
  });

  test('uses milliunits, so float representation cannot split a match', () => {
    expect(buildDedupKey({ account: 'a', date: '2026-01-01', amount: -0.1 - 0.2, payee: 'p' }))
      .toBe(buildDedupKey({ account: 'a', date: '2026-01-01', amount: -0.3, payee: 'p' }));
  });

  test('occurrence distinguishes genuinely identical transactions', () => {
    const base = { account: 'a', date: '2026-01-01', amount: -4, payee: 'Circuit Ride' };
    expect(buildDedupKey(base, 0)).not.toBe(buildDedupKey(base, 1));
  });
});

describe('recomputeDedupKeys', () => {
  test('numbers repeated identical transactions per source', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-03-16', account: 'CSR', payee: 'Circuit Ride', amount: -4 },
      { id: 'a2', source: API, date: '2026-03-16', account: 'CSR', payee: 'Circuit Ride', amount: -4 },
      { id: 'a3', source: API, date: '2026-03-16', account: 'CSR', payee: 'Circuit Ride', amount: -4 }
    ]);
    recomputeDedupKeys(db);
    const keys = db.prepare(`SELECT dedup_key FROM financial_transactions ORDER BY id`).all().map(r => r.dedup_key);
    expect(new Set(keys).size).toBe(3);
    expect(keys.map(k => k.split('|').pop())).toEqual(['0', '1', '2']);
    db.close();
  });

  test('the same set in two sources gets the same keys, so they reconcile', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-03-16', account: 'CSR', payee: 'X', amount: -4 },
      { id: 'a2', source: API, date: '2026-03-16', account: 'CSR', payee: 'X', amount: -4 },
      { id: 'c1', source: CSV, date: '2026-03-16', account: 'CSR', payee: 'X', amount: -4 },
      { id: 'c2', source: CSV, date: '2026-03-16', account: 'CSR', payee: 'X', amount: -4 }
    ]);
    recomputeDedupKeys(db);
    const api = db.prepare(`SELECT dedup_key FROM financial_transactions WHERE source=? ORDER BY id`).all(API).map(r => r.dedup_key);
    const csv = db.prepare(`SELECT dedup_key FROM financial_transactions WHERE source=? ORDER BY id`).all(CSV).map(r => r.dedup_key);
    expect(api.sort()).toEqual(csv.sort());
    db.close();
  });
});

describe('getSourcePrecedence', () => {
  test('falls back to the plugin default when config does not set it', () => {
    expect(getSourcePrecedence(API, {}, PLUGINS)).toBe(100);
    expect(getSourcePrecedence(CSV, {}, PLUGINS)).toBe(50);
  });

  test('configured value overrides the plugin default', () => {
    const config = { plugins: { 'ynab-finance': { default: { precedence: 999 } } } };
    expect(getSourcePrecedence(CSV, config, PLUGINS)).toBe(999);
  });

  test('an unknown source scores 0 rather than outranking anything', () => {
    expect(getSourcePrecedence('mystery/one', {}, PLUGINS)).toBe(0);
  });
});

describe('reconcileFinanceSources', () => {
  test('rule 1: an exact key match supersedes the lower-precedence row', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"budget_name":"Household"}' },
      { id: 'c1', source: CSV, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"source_file":"Household as of 2026-05-02 12-00 - Register.csv"}' }
    ]);
    const report = reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(report.by_key).toBe(1);
    expect(live(db, API)).toBe(1);
    expect(live(db, CSV)).toBe(0);
    // the CSV row points at the API row that replaced it
    expect(db.prepare(`SELECT superseded_by FROM financial_transactions WHERE id='c1'`).get().superseded_by).toBe('a1');
    db.close();
  });

  test('rule 2: a shifted row inside the API window is superseded despite no key match', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Chase', payee: 'AWS', amount: -161.34, metadata: '{"budget_name":"Household"}' },
      { id: 'a2', source: API, date: '2026-06-01', account: 'Chase', payee: 'Other', amount: -10, metadata: '{"budget_name":"Household"}' },
      // pending at export: cleared two days later for a different amount
      { id: 'c1', source: CSV, date: '2026-05-03', account: 'Chase', payee: 'AWS', amount: -159.00, metadata: '{"source_file":"Household as of 2026-05-02 12-00 - Register.csv"}' }
    ]);
    const report = reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(report.by_key).toBe(0);
    expect(report.by_window).toBe(1);
    expect(live(db, CSV)).toBe(0);
    db.close();
  });

  test('rule 3: a projected future row is superseded by the scheduled rule', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Chase', payee: 'Now', amount: -1, metadata: '{"budget_name":"Household"}' },
      // the rule's date_next has rolled on to next year's occurrence
      { id: 'as', source: API, date: '2027-11-12', account: 'Chase', payee: 'Broward County Tax', amount: -10368.54, scheduled: 1, metadata: '{"budget_name":"Household"}' },
      // the CSV froze this year's projection — different date, so no key match,
      // and outside the API's real-transaction window, so rule 2 cannot apply
      { id: 'c1', source: CSV, date: '2026-11-12', account: 'Chase', payee: 'Broward County Tax', amount: -10368.54, metadata: '{"source_file":"Household as of 2026-05-02 12-00 - Register.csv"}' }
    ]);
    const report = reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(report.by_key).toBe(0);
    expect(report.by_window).toBe(0);
    expect(report.by_scheduled).toBe(1);
    expect(db.prepare(`SELECT superseded_by FROM financial_transactions WHERE id='c1'`).get().superseded_by).toBe('as');
    db.close();
  });

  test('rows outside every higher-precedence window survive', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Chase', payee: 'X', amount: -1, metadata: '{"budget_name":"Household"}' },
      // predates the API's retention window — the CSV is the only record of it
      { id: 'c1', source: CSV, date: '2019-01-01', account: 'Chase', payee: 'Ancient', amount: -50, metadata: '{"source_file":"Household as of 2026-05-02 12-00 - Register.csv"}' }
    ]);
    reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(live(db, CSV)).toBe(1);
    db.close();
  });

  test('nothing is ever deleted', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"budget_name":"Household"}' },
      { id: 'c1', source: CSV, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"source_file":"Household as of 2026-05-02 12-00 - Register.csv"}' }
    ]);
    reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(db.prepare(`SELECT COUNT(*) n FROM financial_transactions`).get().n).toBe(2);
    db.close();
  });

  test('is idempotent — running twice changes nothing', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"budget_name":"Household"}' },
      { id: 'c1', source: CSV, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"source_file":"Household as of 2026-05-02 12-00 - Register.csv"}' }
    ]);
    const first = reconcileFinanceSources(db, CONFIG, PLUGINS);
    const snapshot = db.prepare(`SELECT id, superseded_by FROM financial_transactions ORDER BY id`).all();
    const second = reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(second).toMatchObject({ by_key: first.by_key, by_window: first.by_window });
    expect(db.prepare(`SELECT id, superseded_by FROM financial_transactions ORDER BY id`).all()).toEqual(snapshot);
    db.close();
  });

  test('supersession lifts when the winning source goes away', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"budget_name":"Household"}' },
      { id: 'c1', source: CSV, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"source_file":"Household as of 2026-05-02 12-00 - Register.csv"}' }
    ]);
    reconcileFinanceSources(db, CONFIG, PLUGINS);
    expect(live(db, CSV)).toBe(0);

    // the API source is removed; its claim must not outlive it
    db.prepare(`DELETE FROM financial_transactions WHERE source = ?`).run(API);
    reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(live(db, CSV)).toBe(1);
    db.close();
  });

  test('a single source reconciles to a no-op', () => {
    const db = makeDb();
    insert(db, [{ id: 'a1', source: API, date: '2026-05-01', account: 'Chase', payee: 'X', amount: -1 }]);
    const report = reconcileFinanceSources(db, CONFIG, PLUGINS);
    expect(report).toMatchObject({ by_key: 0, by_window: 0, by_scheduled: 0 });
    expect(live(db, API)).toBe(1);
    db.close();
  });

  test('equal precedence supersedes nothing — neither source outranks the other', () => {
    const plugins = new Map([
      ['ynab-api', { settings: { precedence: { default: 50 } } }],
      ['ynab-finance', { settings: { precedence: { default: 50 } } }]
    ]);
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"budget_name":"Household"}' },
      { id: 'c1', source: CSV, date: '2026-05-01', account: 'Chase', payee: 'Disney+', amount: -14.93, metadata: '{"source_file":"Household as of 2026-05-02 12-00 - Register.csv"}' }
    ]);
    reconcileFinanceSources(db, CONFIG, plugins);

    expect(live(db, API)).toBe(1);
    expect(live(db, CSV)).toBe(1);
    db.close();
  });

  test('same-looking rows from different budgets do not supersede each other', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Checking', payee: 'Starbucks', amount: -5, metadata: '{"budget_name":"Household"}' },
      { id: 'c1', source: CSV, date: '2026-05-01', account: 'Checking', payee: 'Starbucks', amount: -5, metadata: '{"source_file":"Travel as of 2026-05-02 12-00 - Register.csv"}' }
    ]);

    const report = reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(report.by_key).toBe(0);
    expect(live(db, API)).toBe(1);
    expect(live(db, CSV)).toBe(1);
    db.close();
  });

  test('a higher-precedence budget window does not hide another budget export', () => {
    const db = makeDb();
    insert(db, [
      { id: 'a1', source: API, date: '2026-05-01', account: 'Checking', payee: 'Rent', amount: -1000, metadata: '{"budget_name":"Household"}' },
      { id: 'a2', source: API, date: '2026-06-01', account: 'Checking', payee: 'Groceries', amount: -50, metadata: '{"budget_name":"Household"}' },
      { id: 'c1', source: CSV, date: '2026-05-15', account: 'Checking', payee: 'Hotel', amount: -250, metadata: '{"source_file":"Travel as of 2026-05-02 12-00 - Register.csv"}' }
    ]);

    const report = reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(report.by_window).toBe(0);
    expect(live(db, CSV)).toBe(1);
    db.close();
  });

  test('a scheduled rule does not hide an old real transaction', () => {
    const db = makeDb();
    insert(db, [
      { id: 'as', source: API, date: '2027-11-12', account: 'Checking', payee: 'Broward County Tax', amount: -10368.54, scheduled: 1, metadata: '{"budget_name":"Household"}' },
      { id: 'c1', source: CSV, date: '2026-01-12', account: 'Checking', payee: 'Broward County Tax', amount: -10368.54, metadata: '{"source_file":"Household as of 2026-05-02 12-00 - Register.csv"}' }
    ]);

    const report = reconcileFinanceSources(db, CONFIG, PLUGINS);

    expect(report.by_scheduled).toBe(0);
    expect(live(db, CSV)).toBe(1);
    db.close();
  });
});
