/**
 * Finance graphs: what a month's total counts.
 *
 * The finance source summed every row, so a graph double-counted a
 * transaction both YNAB plugins hold, plotted scheduled projections into the
 * future, and counted both legs of a transfer, once as expense and once as
 * income. It now counts what bin/finance counts.
 */

import Database from 'better-sqlite3';
import { buildQuery, getMetrics } from '../src/graph-sources.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE financial_transactions (
    id TEXT PRIMARY KEY, source TEXT, date DATE, account TEXT, payee TEXT,
    category TEXT, category_group TEXT, amount REAL,
    scheduled INTEGER DEFAULT 0, transfer INTEGER DEFAULT 0, superseded_by TEXT
  )`);
  return db;
}

function insert(db, rows) {
  const ins = db.prepare(`INSERT INTO financial_transactions
    (id, source, date, account, payee, category, category_group, amount, scheduled, transfer, superseded_by)
    VALUES (@id, 'ynab-api/p', @date, 'Checking', @payee, @category, @category_group, @amount,
            @scheduled, @transfer, @superseded_by)`);
  for (const r of rows) {
    ins.run({ payee: '', scheduled: 0, transfer: 0, superseded_by: null, category: '', category_group: '', ...r });
  }
}

// A date in last month, so the rows fall inside a one-year window and are not
// in the future whenever the suite runs.
function lastMonth(day) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.toISOString().slice(0, 7)}-${String(day).padStart(2, '0')}`;
}

function nextYear() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

const run = (db, metric) => db.prepare(buildQuery('finance', metric, '-1 year')).raw().all();

describe('finance graph source', () => {
  let db;

  beforeEach(() => {
    db = makeDb();
    insert(db, [
      { id: 'patreon', date: lastMonth(6), payee: 'Patreon', category: 'Patreon', category_group: 'OlderGay.Men', amount: 1800 },
      { id: 'railway', date: lastMonth(25), payee: 'Railway', category: 'Railway', category_group: 'OlderGay.Men', amount: -200 },
      { id: 'aws', date: lastMonth(3), payee: 'AWS', category: 'AWS', category_group: 'OlderGay.Men', amount: -400 },
      { id: 'rent', date: lastMonth(10), payee: 'Guest', category: 'Rented Rooms', category_group: 'Income', amount: 900 },
      { id: 'food', date: lastMonth(12), payee: 'Publix', category: 'Groceries', category_group: 'Food', amount: -150 },
      // The same AWS charge from a lower-precedence source
      { id: 'aws-csv', date: lastMonth(3), payee: 'AWS', category: 'AWS', category_group: 'OlderGay.Men', amount: -400, superseded_by: 'aws' },
      // A projection, not something that happened
      { id: 'aws-next', date: nextYear(), payee: 'AWS', category: 'AWS', category_group: 'OlderGay.Men', amount: -400, scheduled: 1 },
      // Both legs of a transfer between the user's own accounts
      { id: 'xfer-out', date: lastMonth(15), payee: 'Transfer : Savings', amount: -5000, transfer: 1 },
      { id: 'xfer-in', date: lastMonth(15), payee: 'Transfer : Checking', amount: 5000, transfer: 1 }
    ]);
  });

  afterEach(() => db.close());

  test('a category group splits into its income and its expenses', () => {
    expect(run(db, 'OlderGay.Men: Income')).toEqual([[lastMonth(1).slice(0, 7), 1800, '$']]);
    expect(run(db, 'OlderGay.Men: Expenses')).toEqual([[lastMonth(1).slice(0, 7), 600, '$']]);
  });

  test('superseded, scheduled and transfer rows are not counted', () => {
    expect(run(db, 'Expenses')).toEqual([[lastMonth(1).slice(0, 7), 750, '$']]);
    expect(run(db, 'Income')).toEqual([[lastMonth(1).slice(0, 7), 2700, '$']]);
  });

  test('a plain group name is still its net total', () => {
    expect(run(db, 'OlderGay.Men')).toEqual([[lastMonth(1).slice(0, 7), 1200, '$']]);
  });

  test('a group name with a quote is escaped', () => {
    insert(db, [{ id: 'q', date: lastMonth(2), category_group: "Jeff's Stuff", amount: -5 }]);
    expect(run(db, "Jeff's Stuff: Expenses")).toEqual([[lastMonth(1).slice(0, 7), 5, '$']]);
  });

  test('each group is listed with its income and expenses metrics', () => {
    const names = getMetrics('finance', db).map(m => m.name);
    expect(names).toEqual(expect.arrayContaining([
      'OlderGay.Men', 'OlderGay.Men: Income', 'OlderGay.Men: Expenses'
    ]));
  });
});
