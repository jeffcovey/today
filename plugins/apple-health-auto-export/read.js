#!/usr/bin/env node

/**
 * Apple Health Auto Export Plugin - Read Command
 *
 * Reads health data exported from the iOS "Health Auto Export" app.
 * Expects JSON files in vault/logs/HealthAutoExport-*.json format.
 *
 * Output: JSON with entries array matching the health schema:
 *   { id, date, metric_name, value, units, metadata }
 */

import fs from 'fs';
import path from 'path';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const logsDirectory = config.logs_directory || 'vault/logs';
const retentionDays = config.retention_days || 30;

// Metrics to include (if specified, otherwise include all)
const metricsFilter = config.metrics_filter
  ? config.metrics_filter.split(',').map(m => m.trim())
  : null;

/**
 * Find the most recent HealthAutoExport file
 */
function findLatestExportFile() {
  const logsDir = path.join(projectRoot, logsDirectory);

  if (!fs.existsSync(logsDir)) {
    return null;
  }

  const files = fs.readdirSync(logsDir)
    .filter(f => f.startsWith('HealthAutoExport-') && f.endsWith('.json'))
    .map(f => {
      // Parse end date from filename: HealthAutoExport-YYYY-MM-DD-YYYY-MM-DD.json
      const match = f.match(/HealthAutoExport-\d{4}-\d{2}-\d{2}-(\d{4}-\d{2}-\d{2})\.json$/);
      return {
        name: f,
        path: path.join(logsDir, f),
        endDate: match ? match[1] : '0000-00-00'
      };
    })
    .sort((a, b) => b.endDate.localeCompare(a.endDate));

  return files[0]?.path || null;
}

/**
 * Parse a date string from Health Auto Export format
 * Input: "2025-12-29 00:00:00 -0500"
 * Output: "2025-12-29"
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  // Extract just the date portion
  const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Calculate the cutoff date based on retention
 */
function getCutoffDate() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Generate a unique ID for a health metric entry
 */
function generateId(metricName, date) {
  return `${metricName}:${date}`;
}

/**
 * Process a single metric and return entries
 */
function processMetric(metric, cutoffDate) {
  const entries = [];
  const { name: metricName, units, data } = metric;

  if (!data || !Array.isArray(data)) {
    return entries;
  }

  // Skip if metrics filter is set and this metric isn't included
  if (metricsFilter && !metricsFilter.includes(metricName)) {
    return entries;
  }

  for (const reading of data) {
    const date = parseDate(reading.date);
    if (!date || date < cutoffDate) {
      continue;
    }

    // For most metrics, qty is the value
    let value = reading.qty;

    // Build metadata object
    const metadata = {};
    if (reading.source) {
      metadata.source_app = reading.source;
    }

    // Special handling for sleep_analysis - has additional fields
    if (metricName === 'sleep_analysis') {
      value = reading.totalSleep || reading.qty || 0;
      if (reading.rem !== undefined) metadata.rem = reading.rem;
      if (reading.deep !== undefined) metadata.deep = reading.deep;
      if (reading.core !== undefined) metadata.core = reading.core;
      if (reading.awake !== undefined) metadata.awake = reading.awake;
      if (reading.inBed !== undefined) metadata.inBed = reading.inBed;
      if (reading.sleepStart) metadata.sleepStart = reading.sleepStart;
      if (reading.sleepEnd) metadata.sleepEnd = reading.sleepEnd;
    }

    entries.push({
      id: generateId(metricName, date),
      date,
      metric_name: metricName,
      value: typeof value === 'number' ? value : parseFloat(value) || 0,
      units: units || null,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
    });
  }

  return entries;
}

/**
 * Main function
 */
function main() {
  const exportFile = findLatestExportFile();

  if (!exportFile) {
    console.log(JSON.stringify({
      entries: [],
      metadata: {
        error: 'No HealthAutoExport files found',
        logs_directory: logsDirectory
      }
    }));
    return;
  }

  let data;
  try {
    const content = fs.readFileSync(exportFile, 'utf8');
    data = JSON.parse(content);
  } catch (error) {
    console.log(JSON.stringify({
      entries: [],
      metadata: {
        error: `Failed to parse ${path.basename(exportFile)}: ${error.message}`
      }
    }));
    return;
  }

  const metrics = data?.data?.metrics;
  if (!metrics || !Array.isArray(metrics)) {
    console.log(JSON.stringify({
      entries: [],
      metadata: {
        error: 'No metrics found in export file',
        source_file: path.basename(exportFile)
      }
    }));
    return;
  }

  const cutoffDate = getCutoffDate();
  const allEntries = [];
  const metricCounts = {};

  for (const metric of metrics) {
    const entries = processMetric(metric, cutoffDate);
    allEntries.push(...entries);

    if (entries.length > 0) {
      metricCounts[metric.name] = entries.length;
    }
  }

  // Sort by date descending, then by metric name
  allEntries.sort((a, b) => {
    const dateCompare = b.date.localeCompare(a.date);
    if (dateCompare !== 0) return dateCompare;
    return a.metric_name.localeCompare(b.metric_name);
  });

  console.log(JSON.stringify({
    entries: allEntries,
    metadata: {
      source_file: path.basename(exportFile),
      entries_count: allEntries.length,
      metrics_count: Object.keys(metricCounts).length,
      retention_days: retentionDays,
      cutoff_date: cutoffDate,
      metrics: metricCounts
    }
  }));
}

main();
