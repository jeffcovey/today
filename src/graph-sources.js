/**
 * Graph data source definitions
 *
 * Shared module used by bin/graph and the data-graphing plugin.
 * Knows how to query each source type and list available metrics.
 */

import { schemas } from './plugin-schemas.js';
import { METRIC_DISPLAY } from './health-metrics.js';

// Reverse mapping: friendly health label -> database metric name
const healthLabelToDb = {};
for (const [dbName, config] of Object.entries(METRIC_DISPLAY)) {
  healthLabelToDb[config.label] = dbName;
}

/**
 * Source definitions
 *
 * Each source has:
 * - listMetrics(db): returns array of { name, description } for available metrics
 * - buildQuery(metric, dateModifier): returns SQL query that produces (date, value, units) rows
 */
const sources = {
  health: {
    description: 'Health metrics from wearables and health apps',
    listMetrics(_db) {
      return Object.entries(METRIC_DISPLAY).map(([dbName, config]) => ({
        name: config.label,
        description: `${config.emoji} ${config.label}`,
        dbName
      }));
    },
    resolveMetric(metric) {
      const dbName = healthLabelToDb[metric];
      if (!dbName) {
        const available = Object.keys(healthLabelToDb).join(', ');
        throw new Error(`Unknown health metric: "${metric}". Available: ${available}`);
      }
      return dbName;
    },
    buildQuery(metric, dateModifier) {
      const dbName = this.resolveMetric(metric);
      return `SELECT date, value, units FROM health_metrics WHERE metric_name = '${dbName}' AND date >= DATE('now', '${dateModifier}') ORDER BY date ASC`;
    }
  },

  finance: {
    description: 'Financial transactions and budget data',
    listMetrics(db) {
      const builtIn = [
        { name: 'Expenses', description: 'Total expenses (negative amounts)' },
        { name: 'Income', description: 'Total income (positive amounts)' }
      ];

      // Get dynamic category groups from database
      if (db) {
        try {
          const rows = db.prepare(
            "SELECT DISTINCT category_group FROM financial_transactions WHERE category_group IS NOT NULL AND category_group != '' ORDER BY category_group"
          ).all();
          const groups = rows.map(r => r.category_group);
          const literal = new Set(groups);
          // A group literally named "X: Income" keeps that name, so the
          // directional metric it would shadow is not offered (buildQuery
          // resolves the name to the literal group too).
          const categories = groups.flatMap(group => [
            { name: group, description: `${group} (category group, net)` },
            ...['Income', 'Expenses']
              .map(direction => `${group}: ${direction}`)
              .filter(name => !literal.has(name))
              .map(name => ({
                name,
                description: `${name} (category group, ${name.endsWith('Income') ? 'inflows' : 'outflows'} only)`
              }))
          ]);
          return [...builtIn, ...categories];
        } catch {
          return builtIn;
        }
      }
      return builtIn;
    },
    resolveMetric(metric) {
      return metric; // Finance metrics are passed through as-is
    },
    buildQuery(metric, dateModifier) {
      const monthExpr = "strftime('%Y-%m', date)";
      const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
      let amountFilter;

      // "<group>: Income" and "<group>: Expenses" split one category group by
      // direction, so a group holding both, like a side business whose income
      // has its own category, can be graphed as income against expenses.
      const split = metric.match(/^(.+):\s*(Income|Expenses)$/);

      if (metric === 'Expenses') {
        amountFilter = 'amount < 0';
      } else if (metric === 'Income') {
        amountFilter = 'amount > 0';
      } else if (split) {
        // A category group whose literal name is the metric wins, so a group
        // named "Business: Income" before this syntax existed still means
        // what it did; only otherwise is the name split by direction.
        const [, group, direction] = split;
        const directional = `category_group = ${quote(group.trim())} AND amount ${direction === 'Income' ? '>' : '<'} 0`;
        amountFilter = `(category_group = ${quote(metric)} OR (${directional} AND NOT EXISTS (SELECT 1 FROM financial_transactions WHERE category_group = ${quote(metric)})))`;
      } else {
        // Treat as a category_group name
        amountFilter = `category_group = ${quote(metric)}`;
      }

      // Count only what happened, once, as bin/finance does: not a row a
      // higher-precedence source superseded (the same transaction from a
      // second plugin), not a scheduled or future projection, and not a
      // transfer between accounts, which is neither income nor expense.
      const reportable = [
        'superseded_by IS NULL',
        'IFNULL(scheduled, 0) = 0',
        'IFNULL(transfer, 0) = 0',
        "date <= DATE('now')"
      ].join(' AND ');

      return `SELECT ${monthExpr} as month, ABS(SUM(amount)) as total, '$' as units FROM financial_transactions WHERE ${amountFilter} AND ${reportable} AND date >= DATE('now', '${dateModifier}') GROUP BY ${monthExpr} ORDER BY month ASC`;
    }
  },

  habits: {
    description: 'Habit tracking and completion rates',
    listMetrics(db) {
      if (db) {
        try {
          const rows = db.prepare(
            "SELECT DISTINCT habit_id, title FROM habits ORDER BY title"
          ).all();
          return rows.map(r => ({
            name: r.title,
            description: `Habit: ${r.title}`,
            dbId: r.habit_id
          }));
        } catch {
          return [];
        }
      }
      return [];
    },
    resolveMetric(metric) {
      return metric;
    },
    buildQuery(metric, dateModifier) {
      // Graph completion status (1 for completed, 0 for not) over time
      return `SELECT date, CASE WHEN status = 'completed' THEN 1 ELSE 0 END as value, '' as units FROM habits WHERE title = '${metric.replace(/'/g, "''")}' AND date >= DATE('now', '${dateModifier}') ORDER BY date ASC`;
    }
  },

  tasks: {
    description: 'Task completion patterns over time',
    listMetrics(_db) {
      return [
        { name: 'Completed', description: 'Tasks completed per day' },
        { name: 'Created', description: 'Tasks created per day' }
      ];
    },
    resolveMetric(metric) {
      return metric;
    },
    buildQuery(metric, dateModifier) {
      if (metric === 'Completed') {
        return `SELECT DATE(completed_at) as date, COUNT(*) as value, '' as units FROM tasks WHERE completed_at IS NOT NULL AND DATE(completed_at) >= DATE('now', '${dateModifier}') GROUP BY DATE(completed_at) ORDER BY date ASC`;
      } else if (metric === 'Created') {
        return `SELECT DATE(created_at) as date, COUNT(*) as value, '' as units FROM tasks WHERE created_at IS NOT NULL AND DATE(created_at) >= DATE('now', '${dateModifier}') GROUP BY DATE(created_at) ORDER BY date ASC`;
      }
      throw new Error(`Unknown tasks metric: "${metric}". Available: Completed, Created`);
    }
  },

  'time-logs': {
    description: 'Time tracking duration over time',
    listMetrics(_db) {
      return [
        { name: 'Total', description: 'Total minutes tracked per day' }
      ];
    },
    resolveMetric(metric) {
      return metric;
    },
    buildQuery(metric, dateModifier) {
      if (metric === 'Total') {
        return `SELECT DATE(start_time) as date, SUM(duration_minutes) as value, 'min' as units FROM time_logs WHERE start_time IS NOT NULL AND DATE(start_time) >= DATE('now', '${dateModifier}') GROUP BY DATE(start_time) ORDER BY date ASC`;
      }
      throw new Error(`Unknown time-logs metric: "${metric}". Available: Total`);
    }
  }
};

/**
 * Get list of supported source names
 */
export function getSupportedSources() {
  return Object.entries(sources).map(([name, src]) => ({
    name,
    description: src.description
  }));
}

/**
 * Get available metrics for a source
 * @param {string} sourceName - Source name (health, finance, etc.)
 * @param {object} db - Optional database instance for dynamic metric discovery
 */
export function getMetrics(sourceName, db = null) {
  const source = sources[sourceName];
  if (!source) {
    throw new Error(`Unknown source: "${sourceName}". Available: ${Object.keys(sources).join(', ')}`);
  }
  return source.listMetrics(db);
}

/**
 * Build a SQL query for the given source, metric, and time period
 * @param {string} sourceName - Source name
 * @param {string} metric - Metric name (friendly)
 * @param {string} dateModifier - SQLite date modifier (e.g., '-6 months')
 * @returns {string} SQL query producing (date, value, units) rows
 */
export function buildQuery(sourceName, metric, dateModifier) {
  const source = sources[sourceName];
  if (!source) {
    throw new Error(`Unknown source: "${sourceName}". Available: ${Object.keys(sources).join(', ')}`);
  }
  return source.buildQuery(metric, dateModifier);
}

/**
 * Parse a human-readable time period into a SQLite date modifier
 */
export function parseTimePeriod(period) {
  const match = period.match(/(\d+)\s*(day|week|month|year)s?/i);
  if (!match) {
    return '-6 months';
  }
  const [, amount, unit] = match;
  return `-${amount} ${unit.toLowerCase()}${parseInt(amount) > 1 ? 's' : ''}`;
}