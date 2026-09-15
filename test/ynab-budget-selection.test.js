/**
 * Tests for ynab-api budget selection (issue #474).
 *
 * The motivating requirement: excluding an archived budget must not come at the
 * cost of silently omitting a budget created later. So the denylist is the
 * default mechanism and every omission is reported.
 */

import { selectBudgets } from '../plugins/ynab-api/select-budgets.js';

const ARCHIVED = { id: 'f019497d-bb49-4c5c-aa3b-6cd15bc0595f', name: 'My Budget (Archived on 2024-03-03)' };
const CURRENT = { id: '370e8c58-7dc8-401b-91e8-40a84e1ea9c8', name: '2024 Fresh Start' };
const FUTURE = { id: '99999999-0000-0000-0000-000000000000', name: '2027 Budget' };

describe('selectBudgets', () => {
  describe('defaults', () => {
    test('syncs every budget when nothing is configured', () => {
      const { selected, excluded } = selectBudgets([ARCHIVED, CURRENT]);
      expect(selected).toEqual([ARCHIVED, CURRENT]);
      expect(excluded).toEqual([]);
    });

    test('tolerates a missing or empty budget list', () => {
      expect(selectBudgets([]).selected).toEqual([]);
      expect(selectBudgets(undefined).selected).toEqual([]);
    });
  });

  describe('exclude_budget_ids', () => {
    test('excludes by id', () => {
      const { selected, excluded } = selectBudgets([ARCHIVED, CURRENT], { excludeBudgetIds: ARCHIVED.id });
      expect(selected).toEqual([CURRENT]);
      expect(excluded).toEqual([{ id: ARCHIVED.id, name: ARCHIVED.name, excluded_by: ARCHIVED.id }]);
    });

    test('excludes by name, since the YNAB UI only shows names', () => {
      const { selected } = selectBudgets([ARCHIVED, CURRENT], { excludeBudgetIds: ARCHIVED.name });
      expect(selected).toEqual([CURRENT]);
    });

    test('name matching is case-insensitive and whitespace-tolerant', () => {
      const { selected } = selectBudgets([ARCHIVED, CURRENT], {
        excludeBudgetIds: '  my budget (ARCHIVED on 2024-03-03)  '
      });
      expect(selected).toEqual([CURRENT]);
    });

    test('accepts several rules', () => {
      const { selected } = selectBudgets([ARCHIVED, CURRENT, FUTURE], {
        excludeBudgetIds: `${ARCHIVED.id}, ${FUTURE.name}`
      });
      expect(selected).toEqual([CURRENT]);
    });

    // The whole point of preferring a denylist.
    test('a budget created later is synced without touching config', () => {
      const { selected } = selectBudgets([ARCHIVED, CURRENT, FUTURE], { excludeBudgetIds: ARCHIVED.id });
      expect(selected).toEqual([CURRENT, FUTURE]);
    });
  });

  describe('budget_ids allowlist', () => {
    test('narrows to the named budgets', () => {
      const { selected, skippedByAllowlist } = selectBudgets([ARCHIVED, CURRENT], { budgetIds: CURRENT.id });
      expect(selected).toEqual([CURRENT]);
      expect(skippedByAllowlist).toEqual([{ id: ARCHIVED.id, name: ARCHIVED.name }]);
    });

    test('"all" is treated as a no-op for backwards compatibility', () => {
      const { selected } = selectBudgets([ARCHIVED, CURRENT], { budgetIds: 'all' });
      expect(selected).toEqual([ARCHIVED, CURRENT]);
    });

    test('exclusions still apply on top of an allowlist', () => {
      const { selected, excluded } = selectBudgets([ARCHIVED, CURRENT, FUTURE], {
        budgetIds: `${CURRENT.id},${ARCHIVED.id}`,
        excludeBudgetIds: ARCHIVED.name
      });
      expect(selected).toEqual([CURRENT]);
      expect(excluded.map(b => b.id)).toEqual([ARCHIVED.id]);
    });

    // Documents the failure mode that motivated the denylist.
    test('an allowlist omits a later budget — reported via skippedByAllowlist', () => {
      const { selected, skippedByAllowlist } = selectBudgets([CURRENT, FUTURE], { budgetIds: CURRENT.id });
      expect(selected).toEqual([CURRENT]);
      expect(skippedByAllowlist).toEqual([{ id: FUTURE.id, name: FUTURE.name }]);
    });
  });

  describe('unmatched rules', () => {
    test('reports an exclusion matching nothing (typo or renamed budget)', () => {
      const { unmatched, selected } = selectBudgets([ARCHIVED, CURRENT], {
        excludeBudgetIds: 'Budget That Does Not Exist'
      });
      expect(unmatched.exclude).toEqual(['Budget That Does Not Exist']);
      expect(selected).toEqual([ARCHIVED, CURRENT]);
    });

    test('reports an allowlist entry matching nothing', () => {
      const { unmatched } = selectBudgets([CURRENT], { budgetIds: 'nope' });
      expect(unmatched.include).toEqual(['nope']);
    });

    test('stays quiet when every rule matches', () => {
      const { unmatched } = selectBudgets([ARCHIVED, CURRENT], { excludeBudgetIds: ARCHIVED.id });
      expect(unmatched).toEqual({ include: [], exclude: [] });
    });
  });

  describe('excluding everything', () => {
    test('yields an empty selection rather than falling back to all', () => {
      const { selected, excluded } = selectBudgets([ARCHIVED, CURRENT], {
        excludeBudgetIds: `${ARCHIVED.id},${CURRENT.id}`
      });
      expect(selected).toEqual([]);
      expect(excluded).toHaveLength(2);
    });
  });
});
