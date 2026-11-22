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
import * as vega from 'vega';
import { compile } from 'vega-lite';
import { buildQuery, parseTimePeriod } from '../../src/graph-sources.js';
import { getTodayDate } from '../../src/date-utils.js';
import { buildSpec, addDarkMode } from './chart-spec.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '../..');

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const contextOnly = process.env.CONTEXT_ONLY === 'true';
const sourceId = process.env.SOURCE_ID || '';
const sourceName = sourceId.split('/').pop() || 'graph';

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
  imageFormat: (config.image_format || 'svg').toLowerCase(),
  width: parseInt(config.width) || 800,
  height: parseInt(config.height) || 450,
  chartType: config.chart_type || 'auto',
  goal: config.goal === undefined || config.goal === '' ? NaN : Number(config.goal),
  averageDays: config.average_days === undefined || config.average_days === '' ? 7 : parseInt(config.average_days, 10),
  chartTitle: config.chart_title || '',
  xAxisLabel: config.x_axis_label || '',
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
 * Render the chart: SVG (with its own dark palette) or a 2x raster.
 */
async function renderChart(datasets) {
  const spec = buildSpec({ datasets, settings, today: getTodayDate() });
  const view = new vega.View(vega.parse(compile(spec).spec), { renderer: 'none' });

  if (settings.imageFormat === 'svg') {
    const svg = await view.toSVG();
    return Buffer.from(addDarkMode(svg, spec.usermeta.colors) + '\n');
  }

  // Raster formats go through node-canvas at twice the size, for sharp
  // text on high-density screens.
  const canvas = await view.toCanvas(2);
  const type = settings.imageFormat === 'jpg' || settings.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
  return canvas.toBuffer(type);
}

/**
 * Save chart to file
 */
function saveChart(buffer) {
  const outputDir = path.resolve(PROJECT_ROOT, settings.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `${settings.filename}.${settings.imageFormat}`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, buffer);
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

    const fileInfo = saveChart(await renderChart(datasets));

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