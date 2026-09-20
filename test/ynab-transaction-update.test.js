/**
 * Tests for YNAB write support (issue #463).
 *
 * The central one is "preserves approved when it was not asked about". YNAB
 * documents `approved` as "If not supplied, transaction will be unapproved by
 * default", so a sparse patch that set only a category would silently un-approve
 * the transaction — a corruption you would notice weeks later, if ever.
 */

import {
  WriteRefused,
  resolveCategoryId,
  assertWritable,
  assertEditable,
  buildTransactionUpdate
} from '../plugins/ynab-api/transaction-update.js';

const GROUPS = [
  {
    name: 'Health',
    categories: [
      { id: 'cat-pharmacy', name: 'Pharmacy' },
      { id: 'cat-medication', name: 'Medication' }
    ]
  },
  {
    name: 'Personal expenses',
    categories: [{ id: 'cat-clothing', name: 'Clothing' }]
  },
  {
    name: 'Food',
    categories: [{ id: 'cat-groceries', name: 'Groceries' }]
  },
  // same leaf name in two groups — the ambiguous case
  {
    name: 'Business',
    categories: [{ id: 'cat-biz-supplies', name: 'Supplies' }]
  },
  {
    name: 'Housing',
    categories: [{ id: 'cat-home-supplies', name: 'Supplies' }]
  },
  {
    name: 'Archived',
    hidden: true,
    categories: [{ id: 'cat-hidden', name: 'Pharmacy' }]
  }
];

// A cleared, approved transaction with a memo — the state that a sparse patch
// would damage.
const CURRENT = {
  id: 'tx-1',
  account_id: 'acct-1',
  date: '2026-09-13',
  amount: -2450,
  payee_id: 'payee-1',
  payee_name: 'Walgreens',
  category_id: 'cat-clothing',
  category_name: 'Clothing',
  memo: 'keep me',
  cleared: 'cleared',
  approved: true,
  flag_color: null,
  deleted: false,
  subtransactions: []
};

describe('resolveCategoryId', () => {
  test('resolves a bare name when it is unique', () => {
    expect(resolveCategoryId(GROUPS, 'Groceries')).toBe('cat-groceries');
  });

  test('resolves a qualified "Group: Category" name', () => {
    expect(resolveCategoryId(GROUPS, 'Health: Pharmacy')).toBe('cat-pharmacy');
  });

  test('is case- and whitespace-insensitive', () => {
    expect(resolveCategoryId(GROUPS, '  health: PHARMACY ')).toBe('cat-pharmacy');
  });

  test('refuses an ambiguous bare name rather than guessing', () => {
    expect(() => resolveCategoryId(GROUPS, 'Supplies')).toThrow(/ambiguous/i);
    // and names both options so the user can disambiguate
    expect(() => resolveCategoryId(GROUPS, 'Supplies')).toThrow(/Business.*Housing|Housing.*Business/s);
  });

  test('a qualified name resolves what a bare one could not', () => {
    expect(resolveCategoryId(GROUPS, 'Housing: Supplies')).toBe('cat-home-supplies');
  });

  test('ignores hidden groups, so an archived duplicate is not ambiguous', () => {
    // "Pharmacy" exists in both Health and the hidden Archived group
    expect(resolveCategoryId(GROUPS, 'Pharmacy')).toBe('cat-pharmacy');
  });

  test('unknown name lists what is available', () => {
    expect(() => resolveCategoryId(GROUPS, 'Nonsense')).toThrow(/No category matching/);
    expect(() => resolveCategoryId(GROUPS, 'Nonsense')).toThrow(/Health: Pharmacy/);
  });
});

describe('assertWritable', () => {
  test('accepts a row synced from the API', () => {
    expect(() => assertWritable({ budget_id: 'b', ynab_id: 't' }, {})).not.toThrow();
  });

  test('refuses a row with no YNAB id — a CSV-export row', () => {
    expect(() => assertWritable({ source_file: 'x.csv' }, {})).toThrow(WriteRefused);
    expect(() => assertWritable({ source_file: 'x.csv' }, {})).toThrow(/only transactions synced from ynab-api/);
  });

  test('refuses a scheduled transaction, which lives on another endpoint', () => {
    expect(() => assertWritable({ budget_id: 'b', ynab_id: 't', scheduled: true }, {}))
      .toThrow(/scheduled transaction/);
  });

  test('carries a hint explaining the refusal', () => {
    try {
      assertWritable({ source_file: 'x.csv' }, {});
    } catch (err) {
      expect(err.hint).toMatch(/CSV export/);
    }
  });
});

describe('assertEditable', () => {
  test('accepts an ordinary transaction', () => {
    expect(() => assertEditable(CURRENT, { category: 'Pharmacy' })).not.toThrow();
  });

  test('refuses a deleted transaction', () => {
    expect(() => assertEditable({ ...CURRENT, deleted: true }, {})).toThrow(/deleted in YNAB/);
  });

  // Without this the write reports success and changes nothing — the worst outcome
  test('refuses a category change on a split transaction', () => {
    const split = { ...CURRENT, subtransactions: [{ id: 's1' }, { id: 's2' }] };
    expect(() => assertEditable(split, { category: 'Pharmacy' })).toThrow(/split transaction/);
  });

  test('allows non-category edits on a split transaction', () => {
    const split = { ...CURRENT, subtransactions: [{ id: 's1' }] };
    expect(() => assertEditable(split, { memo: 'fine' })).not.toThrow();
  });
});

describe('buildTransactionUpdate', () => {
  test('preserves approved when the caller did not mention it', () => {
    // The whole reason this is read-modify-write rather than a sparse patch
    const { update, changed } = buildTransactionUpdate(CURRENT, { category: 'Pharmacy' }, 'cat-pharmacy');
    expect(update.approved).toBe(true);
    expect(changed).toEqual(['category']);
  });

  test('preserves memo and cleared when the caller did not mention them', () => {
    const { update } = buildTransactionUpdate(CURRENT, { category: 'Pharmacy' }, 'cat-pharmacy');
    expect(update.memo).toBe('keep me');
    expect(update.cleared).toBe('cleared');
  });

  test('preserves payee_name when the caller did not mention it', () => {
    const imported = {
      ...CURRENT,
      payee_id: null,
      payee_name: 'Imported Payee'
    };
    const { update } = buildTransactionUpdate(imported, { category: 'Pharmacy' }, 'cat-pharmacy');
    expect(update.payee_name).toBe('Imported Payee');
  });

  test('always sends the immutable identity fields', () => {
    const { update } = buildTransactionUpdate(CURRENT, { memo: 'x' }, undefined);
    expect(update.account_id).toBe('acct-1');
    expect(update.date).toBe('2026-09-13');
    expect(update.amount).toBe(-2450);
  });

  test('reports nothing changed when the desired state already holds', () => {
    const { changed } = buildTransactionUpdate(CURRENT, { category: 'Clothing' }, 'cat-clothing');
    expect(changed).toEqual([]);
  });

  test('an empty memo clears it to null rather than an empty string', () => {
    const { update, changed } = buildTransactionUpdate(CURRENT, { memo: '' }, undefined);
    expect(update.memo).toBeNull();
    expect(changed).toEqual(['memo']);
  });

  test('clearing an already-empty memo is not a change', () => {
    const { changed } = buildTransactionUpdate({ ...CURRENT, memo: null }, { memo: '' }, undefined);
    expect(changed).toEqual([]);
  });

  test('setting a payee clears payee_id so the name is what resolves', () => {
    const { update, changed } = buildTransactionUpdate(CURRENT, { payee: 'CVS' }, undefined);
    expect(update.payee_id).toBeNull();
    expect(update.payee_name).toBe('CVS');
    expect(changed).toEqual(['payee']);
  });

  test('an empty flag clears it', () => {
    const flagged = { ...CURRENT, flag_color: 'red' };
    const { update, changed } = buildTransactionUpdate(flagged, { flag: '' }, undefined);
    expect(update.flag_color).toBeNull();
    expect(changed).toEqual(['flag']);
  });

  test('approved can be set false explicitly', () => {
    const { update, changed } = buildTransactionUpdate(CURRENT, { approved: false }, undefined);
    expect(update.approved).toBe(false);
    expect(changed).toEqual(['approved']);
  });

  test('records every field that actually moved', () => {
    const { changed } = buildTransactionUpdate(
      CURRENT,
      { category: 'Pharmacy', memo: 'new', approved: false, flag: 'blue' },
      'cat-pharmacy'
    );
    expect(changed.sort()).toEqual(['approved', 'category', 'flag', 'memo']);
  });

  test('a field set to its current value is not reported as changed', () => {
    const { changed } = buildTransactionUpdate(
      CURRENT,
      { memo: 'keep me', approved: true, payee: 'Walgreens' },
      undefined
    );
    expect(changed).toEqual([]);
  });
});
