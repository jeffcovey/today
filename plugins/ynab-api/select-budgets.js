/**
 * Budget selection for the ynab-api plugin.
 *
 * Two settings, resolved in order:
 *   budget_ids          allowlist — when set, only these are considered
 *   exclude_budget_ids  denylist  — removed from whatever remains
 *
 * The denylist is the preferred form: everything syncs by default, so a budget
 * created later is picked up automatically instead of being silently omitted.
 *
 * Both match on budget id OR budget name, because requiring a UUID for a thing
 * the YNAB UI only ever shows by name is poor ergonomics.
 *
 * Kept free of I/O so the resolution rules can be tested directly.
 */

function matches(budget, rule) {
  if (budget.id === rule) return true;
  return String(budget.name || '').toLowerCase() === rule.toLowerCase();
}

function parseRules(value, budgets = []) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const parseRuleLine = (line) => {
    const normalized = line.trim().replace(/,+$/, '').trim();
    if (!normalized) return [];
    if (budgets.some(b => matches(b, normalized))) return [normalized];
    return normalized.split(',').map(s => s.trim()).filter(Boolean);
  };

  if (raw.includes('\n')) {
    return raw.split(/\r?\n/).flatMap(parseRuleLine);
  }

  return parseRuleLine(raw);
}

/**
 * @returns {{
 *   selected: Array,                       budgets to sync
 *   excluded: Array,                       removed by exclude_budget_ids, each with excluded_by
 *   skippedByAllowlist: Array,             dropped because budget_ids named others
 *   unmatched: {include: string[], exclude: string[]}   rules matching no budget
 * }}
 */
export function selectBudgets(budgets, { budgetIds = '', excludeBudgetIds = '' } = {}) {
  const all = Array.isArray(budgets) ? budgets : [];

  // "all" is accepted as an explicit no-op for backwards compatibility
  const include = parseRules(budgetIds, all).filter(r => r.toLowerCase() !== 'all');
  const exclude = parseRules(excludeBudgetIds, all);

  const candidates = include.length > 0
    ? all.filter(b => include.some(r => matches(b, r)))
    : all;

  const skippedByAllowlist = include.length > 0
    ? all.filter(b => !candidates.includes(b)).map(b => ({ id: b.id, name: b.name }))
    : [];

  const selected = [];
  const excluded = [];
  for (const budget of candidates) {
    const rule = exclude.find(r => matches(budget, r));
    if (rule) excluded.push({ id: budget.id, name: budget.name, excluded_by: rule });
    else selected.push(budget);
  }

  // A rule matching nothing is almost always a typo or a renamed budget. Silence
  // there would defeat the point of a denylist, so it is reported.
  const unmatched = {
    include: include.filter(r => !all.some(b => matches(b, r))),
    exclude: exclude.filter(r => !all.some(b => matches(b, r)))
  };

  return { selected, excluded, skippedByAllowlist, unmatched };
}
