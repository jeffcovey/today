/**
 * Cross-source reconciliation for financial transactions (issue #479).
 *
 * Two finance plugins can hold the same transaction — a CSV export and a live
 * API, say — with no shared identifier, because YNAB's Register.csv has no ID
 * column. Without reconciliation every unfiltered query double-counts.
 *
 * Nothing is deleted. A losing row keeps its place and records `superseded_by`,
 * pointing at the row that replaces it, so the decision is auditable and
 * reversible: drop the higher-precedence source and its claims lift.
 *
 * Three rules, applied in order of confidence:
 *
 *   1. dedup_key     exact natural-key match. No false positives.
 *   2. window        a row inside a range a higher-precedence source covers
 *                    authoritatively is a duplicate or stale even when no key
 *                    matches — which is what happens when a transaction was
 *                    pending at export and its date or amount shifted on
 *                    clearing. Measured on real data: 38 of 47 unmatched rows.
 *   3. scheduled     a projected future row matching a higher-precedence
 *                    scheduled rule is superseded by that rule.
 */

/**
 * Natural key for a transaction. `occurrence` disambiguates genuinely identical
 * transactions on the same day — three $4 charges to the same payee is real, and
 * memo does not separate them. YNAB's own import_id has the same shape:
 * `YNAB:[milliunits]:[date]:[occurrence]`.
 */
export function buildDedupKey({ account, date, amount, payee }, occurrence = 0) {
  const milliunits = Math.round(Number(amount || 0) * 1000);
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  return [norm(account), date, milliunits, norm(payee), occurrence].join('|');
}

/**
 * Assign dedup keys to a batch, numbering collisions deterministically.
 * Callers must pass rows in a stable order so occurrence numbers are reproducible.
 */
export function assignDedupKeys(rows) {
  const seen = new Map();
  return rows.map(row => {
    const base = buildDedupKey(row, 0).slice(0, -2); // key without the occurrence
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...row, dedup_key: buildDedupKey(row, n) };
  });
}

/**
 * Recompute dedup_key for every finance row, in SQL.
 *
 * Deliberately central rather than per-plugin: two plugins computing "the same"
 * key independently is how #470 and #472 happened. One algorithm, applied to
 * every source, also means occurrence numbering stays consistent after an
 * incremental sync that only touched part of a source.
 *
 * Ordering by id makes the numbering deterministic; which of three identical
 * rows gets occurrence 0 does not matter, only that both sources number a
 * matching set the same way.
 */
export function recomputeDedupKeys(db) {
  const info = db.prepare(`PRAGMA table_info(financial_transactions)`).all();
  if (!info.some(c => c.name === 'dedup_key')) return 0;

  return db.prepare(`
    WITH numbered AS (
      SELECT
        id,
        LOWER(TRIM(IFNULL(account, ''))) || '|' ||
        date || '|' ||
        CAST(ROUND(amount * 1000) AS INTEGER) || '|' ||
        LOWER(TRIM(IFNULL(payee, ''))) AS base,
        ROW_NUMBER() OVER (
          PARTITION BY
            source,
            LOWER(TRIM(IFNULL(account, ''))),
            date,
            CAST(ROUND(amount * 1000) AS INTEGER),
            LOWER(TRIM(IFNULL(payee, '')))
          ORDER BY id
        ) - 1 AS occ
      FROM financial_transactions
    )
    UPDATE financial_transactions
    SET dedup_key = (
      SELECT n.base || '|' || n.occ FROM numbered n WHERE n.id = financial_transactions.id
    )
  `).run().changes;
}

/**
 * Resolve per-source precedence. Higher wins.
 *
 * The configured value takes priority, falling back to the plugin.toml default —
 * getFullConfig() returns raw TOML and does not merge plugin defaults, so reading
 * config alone would score every unconfigured source 0 and reconcile nothing.
 *
 * @param {string} sourceId              e.g. "ynab-api/personal"
 * @param {object} config                full config from getFullConfig()
 * @param {Map|object} plugins           discovered plugins, for settings defaults
 */
export function getSourcePrecedence(sourceId, config, plugins) {
  const [pluginName, sourceName] = String(sourceId).split('/');

  const configured = Number(config?.plugins?.[pluginName]?.[sourceName]?.precedence);
  if (Number.isFinite(configured)) return configured;

  const plugin = plugins instanceof Map ? plugins.get(pluginName) : plugins?.[pluginName];
  const fallback = Number(plugin?.settings?.precedence?.default);
  return Number.isFinite(fallback) ? fallback : 0;
}

/**
 * Budget identity shared across sources. Prefer explicit metadata; fall back to
 * the CSV export filename used by ynab-finance so existing rows still scope
 * correctly before that plugin starts writing budget_name directly.
 */
function budgetScopeSql(alias) {
  return `COALESCE(
    NULLIF(LOWER(TRIM(json_extract(${alias}.metadata, '$.budget_name'))), ''),
    CASE
      WHEN INSTR(COALESCE(json_extract(${alias}.metadata, '$.source_file'), ''), ' as of ') > 0
      THEN LOWER(TRIM(SUBSTR(
        json_extract(${alias}.metadata, '$.source_file'),
        1,
        INSTR(json_extract(${alias}.metadata, '$.source_file'), ' as of ') - 1
      )))
    END,
    NULLIF(LOWER(TRIM(json_extract(${alias}.metadata, '$.budget_id'))), '')
  )`;
}

function budgetMatchSql(leftAlias, rightAlias) {
  const left = budgetScopeSql(leftAlias);
  const right = budgetScopeSql(rightAlias);
  return `(${left} IS NULL OR ${right} IS NULL OR ${left} = ${right})`;
}

/**
 * Date ranges a source covers authoritatively, derived from its own
 * non-scheduled rows. A source cannot claim a window it has no data in, and one
 * budget's coverage must not hide another budget's export.
 */
function coverageWindows(db, sourceId) {
  const budgetScope = budgetScopeSql('financial_transactions');
  return db.prepare(`
    SELECT ${budgetScope} AS budget_scope, MIN(date) AS start, MAX(date) AS end
    FROM financial_transactions
    WHERE source = ? AND IFNULL(scheduled, 0) = 0
    GROUP BY 1
  `).all(sourceId).filter(row => row.start && row.end);
}

/**
 * Reconcile all finance sources. Returns a report of what was superseded and why.
 *
 * @param {object} db
 * @param {object} config - full config, for per-source `precedence`
 * @param {Map|object} plugins - discovered plugins, for precedence defaults
 */
export function reconcileFinanceSources(db, config, plugins) {
  recomputeDedupKeys(db);

  const sources = db.prepare(`
    SELECT DISTINCT source FROM financial_transactions
  `).all().map(r => r.source);

  const ranked = sources
    .map(source => ({ source, precedence: getSourcePrecedence(source, config, plugins) }))
    .sort((a, b) => b.precedence - a.precedence);

  // Start from a clean slate so precedence changes and removed sources take
  // effect — a row stays superseded only while something still supersedes it.
  db.prepare(`UPDATE financial_transactions SET superseded_by = NULL`).run();

  const report = { by_key: 0, by_window: 0, by_scheduled: 0, sources: ranked };
  if (ranked.length < 2) return report;

  const apply = db.transaction(() => {
    for (const winner of ranked) {
      const losers = ranked.filter(r => r.precedence < winner.precedence).map(r => r.source);
      if (losers.length === 0) continue;
      const placeholders = losers.map(() => '?').join(',');

      // 1. exact natural-key match
      report.by_key += db.prepare(`
        UPDATE financial_transactions AS loser
        SET superseded_by = (
          SELECT w.id FROM financial_transactions w
          WHERE w.source = ? AND w.dedup_key = loser.dedup_key
            AND ${budgetMatchSql('w', 'loser')}
          LIMIT 1
        )
        WHERE loser.source IN (${placeholders})
          AND loser.superseded_by IS NULL
          AND loser.dedup_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM financial_transactions w
            WHERE w.source = ? AND w.dedup_key = loser.dedup_key
              AND ${budgetMatchSql('w', 'loser')}
          )
      `).run(winner.source, ...losers, winner.source).changes;

      // 2. window precedence
      for (const window of coverageWindows(db, winner.source)) {
        report.by_window += db.prepare(`
          UPDATE financial_transactions AS loser
          SET superseded_by = ?
          WHERE loser.source IN (${placeholders})
            AND loser.superseded_by IS NULL
            AND IFNULL(loser.scheduled, 0) = 0
            AND (? IS NULL OR ${budgetScopeSql('loser')} IS NULL OR ${budgetScopeSql('loser')} = ?)
            AND loser.date BETWEEN ? AND ?
        `).run(
          `source:${winner.source}`,
          ...losers,
          window.budget_scope,
          window.budget_scope,
          window.start,
          window.end
        ).changes;
      }

      // 3. scheduled-rule precedence — a projection replaced by the rule itself
      report.by_scheduled += db.prepare(`
        UPDATE financial_transactions AS loser
        SET superseded_by = (
          SELECT w.id FROM financial_transactions w
          WHERE w.source = ? AND IFNULL(w.scheduled,0) = 1
            AND w.amount = loser.amount
            AND IFNULL(LOWER(TRIM(w.payee)),'') = IFNULL(LOWER(TRIM(loser.payee)),'')
            AND ${budgetMatchSql('w', 'loser')}
          LIMIT 1
        )
        WHERE loser.source IN (${placeholders})
          AND loser.superseded_by IS NULL
          AND loser.date >= DATE('now')
          AND EXISTS (
            SELECT 1 FROM financial_transactions w
            WHERE w.source = ? AND IFNULL(w.scheduled,0) = 1
              AND w.amount = loser.amount
              AND IFNULL(LOWER(TRIM(w.payee)),'') = IFNULL(LOWER(TRIM(loser.payee)),'')
              AND ${budgetMatchSql('w', 'loser')}
          )
      `).run(winner.source, ...losers, winner.source).changes;
    }
  });

  apply();
  return report;
}
