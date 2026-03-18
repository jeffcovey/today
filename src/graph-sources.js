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
          const categories = rows.map(r => ({
            name: r.category_group,
            description: `Category group: ${r.category_group}`
          }));
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
      let amountFilter;

      if (metric === 'Expenses') {
        amountFilter = 'amount < 0';
      } else if (metric === 'Income') {
        amountFilter = 'amount > 0';
      } else {
        // Treat as a category_group name
        amountFilter = `category_group = '${metric.replace(/'/g, "''")}'`;
      }

      return `SELECT ${monthExpr} as month, ABS(SUM(amount)) as total, '$' as units FROM financial_transactions WHERE ${amountFilter} AND date >= DATE('now', '${dateModifier}') GROUP BY ${monthExpr} ORDER BY month ASC`;
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