/**
 * Pure logic for updating a YNAB transaction (issue #463).
 *
 * Kept free of I/O so the parts that can quietly corrupt a budget — which fields
 * get sent, how a category name resolves, which transactions must be refused —
 * are testable without touching the network or a real budget.
 */

export class WriteRefused extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'WriteRefused';
    this.hint = hint;
  }
}

/**
 * Resolve a category name to its id.
 *
 * Callers work in names — "Groceries" — because that is what a person and the AI
 * both see. Accepts "Group: Category" since a category name is only unique within
 * its group. An ambiguous name raises rather than guessing: picking the wrong one
 * files money under the wrong heading and is easy to miss for months.
 */
export function resolveCategoryId(categoryGroups, categoryName) {
  const wanted = String(categoryName).trim().toLowerCase();
  const visible = (categoryGroups || []).filter(g => !g.deleted && !g.hidden);

  const candidates = [];
  for (const group of visible) {
    for (const cat of (group.categories || [])) {
      if (cat.deleted || cat.hidden) continue;
      const full = `${group.name}: ${cat.name}`.toLowerCase();
      if (full === wanted || String(cat.name).trim().toLowerCase() === wanted) {
        candidates.push({ id: cat.id, name: cat.name, group: group.name });
      }
    }
  }

  if (candidates.length === 0) {
    const available = visible.flatMap(g =>
      (g.categories || []).filter(c => !c.deleted && !c.hidden).map(c => `${g.name}: ${c.name}`)
    );
    throw new WriteRefused(
      `No category matching "${categoryName}". Available: ${available.slice(0, 12).join(', ')}` +
      (available.length > 12 ? `, … (${available.length} total)` : '')
    );
  }

  if (candidates.length > 1) {
    throw new WriteRefused(
      `"${categoryName}" is ambiguous across ${candidates.length} groups: ` +
      `${candidates.map(c => `${c.group}: ${c.name}`).join(', ')}. ` +
      `Qualify it as "Group: Category".`
    );
  }

  return candidates[0].id;
}

/**
 * Refuse writes that cannot work, before anything is sent.
 * Each of these would otherwise appear to succeed while doing nothing useful.
 */
export function assertWritable(metadata, entry) {
  if (!metadata?.budget_id || !metadata?.ynab_id) {
    throw new WriteRefused(
      'Entry is missing budget_id or ynab_id in metadata — only transactions synced from ynab-api can be written back',
      'Rows from the CSV export plugin carry no YNAB id and cannot be updated via the API'
    );
  }
  if (metadata.scheduled) {
    throw new WriteRefused(
      'This is a scheduled transaction; it lives on a different YNAB endpoint and is not writable here',
      'Edit the recurring rule in YNAB directly'
    );
  }
}

/** Refuse edits the remote state makes impossible. */
export function assertEditable(current, entry) {
  if (current?.deleted) {
    throw new WriteRefused('That transaction has been deleted in YNAB');
  }
  // A split transaction's categories live on its subtransactions. YNAB ignores
  // category_id on the parent, so this would report success and change nothing.
  const isSplit = Array.isArray(current?.subtransactions) && current.subtransactions.length > 0;
  if (isSplit && entry.category !== undefined) {
    throw new WriteRefused(
      'That is a split transaction — its categories live on the split lines, and YNAB ignores a category set on the parent',
      'Edit the split in YNAB directly'
    );
  }
}

/**
 * Build the complete object to send, overlaying the caller's changes on current state.
 *
 * Deliberately a full object rather than a sparse patch. YNAB documents `approved`
 * as "If not supplied, transaction will be unapproved by default", so an update
 * that named only a category would silently un-approve the transaction. Sending
 * everything makes that class of surprise impossible.
 *
 * @returns {{update: object, changed: string[]}} changed is empty when the desired
 *          state already holds, which callers treat as "skip the write"
 */
export function buildTransactionUpdate(current, entry, resolvedCategoryId) {
  const changed = [];
  const update = {
    account_id: current.account_id,
    date: current.date,
    amount: current.amount,
    payee_id: current.payee_id,
    payee_name: current.payee_name,
    category_id: current.category_id,
    memo: current.memo,
    cleared: current.cleared,
    approved: current.approved,
    flag_color: current.flag_color,
    import_id: current.import_id
  };

  if (resolvedCategoryId !== undefined && resolvedCategoryId !== null) {
    if (resolvedCategoryId !== current.category_id) changed.push('category');
    update.category_id = resolvedCategoryId;
  }

  if (entry.payee !== undefined && entry.payee !== current.payee_name) {
    // payee_name resolves to an existing payee or creates one, but only when
    // payee_id is null — otherwise the id wins and the name is ignored.
    update.payee_id = null;
    update.payee_name = entry.payee;
    changed.push('payee');
  }

  if (entry.memo !== undefined) {
    // An empty memo means clear it. YNAB stores an absent memo as null, so
    // sending "" would leave the row subtly different from a genuinely empty one.
    const memo = entry.memo === '' ? null : entry.memo;
    if (memo !== current.memo) {
      update.memo = memo;
      changed.push('memo');
    }
  }

  if (entry.flag !== undefined) {
    const flag = entry.flag || null;
    if (flag !== current.flag_color) {
      update.flag_color = flag;
      changed.push('flag');
    }
  }

  if (entry.approved !== undefined && Boolean(entry.approved) !== current.approved) {
    update.approved = Boolean(entry.approved);
    changed.push('approved');
  }

  if (entry.cleared !== undefined && entry.cleared !== current.cleared) {
    update.cleared = entry.cleared;
    changed.push('cleared');
  }

  return { update, changed };
}
