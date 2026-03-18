#!/usr/bin/env node

/**
 * Data Graphing Plugin
 *
 * Generates graphs from configured data sources.
 * Supports multiple data curves on a single chart.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createCanvas } from 'canvas';
import Chart from 'chart.js/auto';
import { buildQuery, parseTimePeriod } from '../../src/graph-sources.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '../..');

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const contextOnly = process.env.CONTEXT_ONLY === 'true';
const sourceId = process.env.SOURCE_ID || '';
const sourceName = sourceId.split('/').pop() || 'graph';

// Default color palette for multi-curve charts
const DEFAULT_COLORS = [
  '#2196f3', '#4CAF50', '#e53935', '#FF9800', '#9C27B0',
  '#00BCD4', '#795548', '#607D8B', '#E91E63', '#3F51B5'
];

// Parse config — support both single metric and multi-metric
const metrics = config.metrics
  ? (Array.isArray(config.metrics) ? config.metrics : JSON.parse(config.metrics))
  : (config.metric ? [config.metric] : []);

const colorConfig = config.colors
  ? (Array.isArray(config.colors) ? config.colors : JSON.parse(config.colors))
  : (config.data_color ? [config.data_color] : []);

const settings = {
  source: config.source || 'health',
  metrics,
  colors: colorConfig,
  timePeriod: config.time_period || '6 months',
  filename: config.filename || sourceName,
  outputPath: config.output_path || 'vault/graphs',
  imageFormat: config.image_format || 'png',
  width: parseInt(config.width) || 800,
  height: parseInt(config.height) || 600,
  chartTitle: config.chart_title || '',
  xAxisLabel: config.x_axis_label || 'Date',
  yAxisLabel: config.y_axis_label || ''
};

/**
 * Run a SQL query and return parsed rows
 */
function runQuery(query) {
  const result = execSync(
    `sqlite3 "${PROJECT_ROOT}/.data/today.db" "${query}"`,
    { encoding: 'utf8' }
  );

  if (!result.trim()) return null;

  return result.trim().split('\n').map(row => {
    const parts = row.split('|');
    return {
      date: parts[0],
      value: parseFloat(parts[1]),
      units: parts[2] || ''
    };
  });
}

/**
 * Query data for a single metric
 */
function queryMetric(metric) {
  const dateModifier = parseTimePeriod(settings.timePeriod);
  const query = buildQuery(settings.source, metric, dateModifier);
  return runQuery(query);
}

/**
 * Create chart with one or more datasets
 */
function createChart(datasets) {
  const canvas = createCanvas(settings.width, settings.height);
  const ctx = canvas.getContext('2d');

  // Merge all x-axis labels from all datasets and sort
  const allDates = new Set();
  for (const ds of datasets) {
    for (const row of ds.rows) {
      allDates.add(row.date);
    }
  }
  const labels = [...allDates].sort();

  // Build Chart.js datasets
  const chartDatasets = datasets.map((ds, i) => {
    const color = settings.colors[i] || DEFAULT_COLORS[i % DEFAULT_COLORS.length];

    // Map rows to the shared x-axis, filling gaps with null
    const dateMap = new Map(ds.rows.map(r => [r.date, r.value]));
    const data = labels.map(d => dateMap.get(d) ?? null);

    return {
      label: ds.metric,
      data,
      borderColor: color,
      backgroundColor: color + '20',
      fill: datasets.length === 1,
      tension: 0.1,
      spanGaps: true
    };
  });

  const title = settings.chartTitle ||
    (datasets.length === 1
      ? `${datasets[0].metric} - ${settings.timePeriod}`
      : settings.metrics.join(' vs ') + ` - ${settings.timePeriod}`);

  const yLabel = settings.yAxisLabel ||
    (datasets[0].units ? `Value (${datasets[0].units})` : '');

  new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: chartDatasets },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: { display: true, text: title }
      },
      scales: {
        x: { title: { display: true, text: settings.xAxisLabel } },
        y: { title: { display: !!yLabel, text: yLabel } }
      }
    }
  });

  return canvas;
}

/**
 * Save chart to file
 */
function saveChart(canvas) {
  const outputDir = path.join(PROJECT_ROOT, settings.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `${settings.filename}.${settings.imageFormat}`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, canvas.toBuffer(`image/${settings.imageFormat}`));
  return { filename, filepath };
}

/**
 * Main
 */
async function main() {
  if (contextOnly) {
    console.log(JSON.stringify({
      context: `Graph: ${settings.source} / ${settings.metrics.join(', ')} for ${settings.timePeriod}`,
      output_file: `${settings.filename}.${settings.imageFormat}`
    }));
    return;
  }

  if (settings.metrics.length === 0) {
    console.error('Error: No metric(s) configured. Set "metric" or "metrics" in your source config.');
    process.exit(1);
  }

  try {
    // Query each metric
    const datasets = [];
    for (const metric of settings.metrics) {
      const rows = queryMetric(metric);
      if (rows) {
        datasets.push({ metric, rows, units: rows[0]?.units || '' });
      } else {
        console.error(`Warning: No data for ${settings.source}/${metric}`);
      }
    }

    if (datasets.length === 0) {
      console.log(JSON.stringify({
        error: `No data found for any metric in ${settings.source} for ${settings.timePeriod}`
      }));
      return;
    }

    const canvas = createChart(datasets);
    const fileInfo = saveChart(canvas);

    console.log(JSON.stringify({
      generated_graph: {
        source: sourceId,
        metrics: settings.metrics,
        time_period: settings.timePeriod,
        datasets: datasets.length,
        data_points: datasets.reduce((sum, ds) => sum + ds.rows.length, 0),
        ...fileInfo
      }
    }));
  } catch (error) {
    console.error(`Error generating graph: ${error.message}`);
    process.exit(1);
  }
}

main();