#!/usr/bin/env node

// Database Cleanup Plugin
// Performs various database maintenance tasks:
// 1. Clean up old backup files (by count and/or total size)
// 2. Delete empty/stale database files
// 3. VACUUM database to reclaim space
// 4. Prune old sync_metadata entries

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

const dataDirectory = config.data_directory || '.data';
const maxBackups = config.max_backups ?? 5;
const maxDataSizeMB = config.max_data_size_mb ?? 500;
const deleteEmptyFiles = config.delete_empty_files !== false;
const shouldVacuum = config.vacuum !== false;
const syncMetadataRetentionDays = config.sync_metadata_retention_days ?? 90;

const dataDir = path.join(projectRoot, dataDirectory);
const dbPath = path.join(dataDir, 'today.db');

// Results tracking
const results = {
  backups_cleaned: 0,
  empty_files_deleted: 0,
  space_freed_mb: 0,
  vacuumed: false,
  vacuum_freed_mb: 0,
  sync_metadata_pruned: 0
};

// Check if directory exists
if (!fs.existsSync(dataDir)) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      message: `Data directory not found: ${dataDirectory}`,
      ...results
    }
  }));
  process.exit(0);
}

// ============================================================================
// Helper functions
// ============================================================================

function getFilesWithSizes() {
  const files = [];
  for (const name of fs.readdirSync(dataDir)) {
    const filePath = path.join(dataDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        files.push({
          name,
          path: filePath,
          size: stat.size,
          sizeMB: stat.size / 1024 / 1024
        });
      }
    } catch {
      // Skip files we can't stat
    }
  }
  return files;
}

function getBackupFiles(allFiles) {
  return allFiles
    .filter(f => f.name.match(/\.db\.backup-/))
    .map(f => ({
      ...f,
      timestamp: f.name.match(/\.backup-(.+)$/)?.[1] || ''
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)); // Oldest first
}

function getTotalSizeMB(allFiles) {
  return allFiles.reduce((sum, f) => sum + f.sizeMB, 0);
}

function runSql(sql) {
  try {
    return execSync(`sqlite3 "${dbPath}" "${sql}"`, {
      encoding: 'utf8',
      timeout: 30000
    }).trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Task 1: Clean up old backup files
// ============================================================================

function cleanBackupFiles() {
  const allFiles = getFilesWithSizes();
  const backupFiles = getBackupFiles(allFiles);
  let currentSizeMB = getTotalSizeMB(allFiles);
  let freedMB = 0;
  let deletedCount = 0;

  // By count
  if (maxBackups > 0 && backupFiles.length > maxBackups) {
    const toDelete = backupFiles.slice(0, backupFiles.length - maxBackups);
    for (const file of toDelete) {
      try {
        fs.unlinkSync(file.path);
        currentSizeMB -= file.sizeMB;
        freedMB += file.sizeMB;
        deletedCount++;
      } catch {
        // Skip
      }
    }
  }

  // By size
  if (maxDataSizeMB > 0 && currentSizeMB > maxDataSizeMB) {
    const remainingBackups = getBackupFiles(getFilesWithSizes());
    for (const file of remainingBackups) {
      if (currentSizeMB <= maxDataSizeMB) break;
      try {
        fs.unlinkSync(file.path);
        currentSizeMB -= file.sizeMB;
        freedMB += file.sizeMB;
        deletedCount++;
      } catch {
        // Skip
      }
    }
  }

  results.backups_cleaned = deletedCount;
  results.space_freed_mb += freedMB;
}

// ============================================================================
// Task 2: Delete empty database files
// ============================================================================

function cleanEmptyFiles() {
  if (!deleteEmptyFiles) return;

  const allFiles = getFilesWithSizes();
  const emptyFiles = allFiles.filter(f =>
    f.name.endsWith('.db') &&
    f.name !== 'today.db' &&
    f.size === 0
  );

  for (const file of emptyFiles) {
    try {
      fs.unlinkSync(file.path);
      results.empty_files_deleted++;
    } catch {
      // Skip
    }
  }
}

// ============================================================================
// Task 3: VACUUM database
// ============================================================================

function vacuumDatabase() {
  if (!shouldVacuum || !fs.existsSync(dbPath)) return;

  try {
    const sizeBefore = fs.statSync(dbPath).size;
    runSql('VACUUM;');
    const sizeAfter = fs.statSync(dbPath).size;
    const freedMB = (sizeBefore - sizeAfter) / 1024 / 1024;

    results.vacuumed = true;
    if (freedMB > 0) {
      results.vacuum_freed_mb = Math.round(freedMB * 10) / 10;
      results.space_freed_mb += freedMB;
    }
  } catch {
    // Skip if vacuum fails
  }
}

// ============================================================================
// Task 4: Prune old sync_metadata
// ============================================================================

function pruneSyncMetadata() {
  if (syncMetadataRetentionDays <= 0 || !fs.existsSync(dbPath)) return;

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - syncMetadataRetentionDays);
    const cutoff = cutoffDate.toISOString();

    // Check if table exists
    const tables = runSql(".tables");
    if (!tables || !tables.includes('sync_metadata')) return;

    const countBefore = parseInt(runSql('SELECT COUNT(*) FROM sync_metadata;') || '0');
    runSql(`DELETE FROM sync_metadata WHERE last_synced_at < '${cutoff}';`);
    const countAfter = parseInt(runSql('SELECT COUNT(*) FROM sync_metadata;') || '0');

    results.sync_metadata_pruned = countBefore - countAfter;
  } catch {
    // Skip if pruning fails
  }
}

// ============================================================================
// Run all tasks
// ============================================================================

cleanBackupFiles();
cleanEmptyFiles();
vacuumDatabase();
pruneSyncMetadata();

// Round the final space freed
results.space_freed_mb = Math.round(results.space_freed_mb * 10) / 10;

// Build status message
const actions = [];
if (results.backups_cleaned > 0) actions.push(`${results.backups_cleaned} backup(s)`);
if (results.empty_files_deleted > 0) actions.push(`${results.empty_files_deleted} empty file(s)`);
if (results.vacuumed) actions.push('vacuumed');
if (results.sync_metadata_pruned > 0) actions.push(`${results.sync_metadata_pruned} old sync records`);

if (actions.length > 0) {
  let msg = `Cleaned: ${actions.join(', ')}`;
  if (results.space_freed_mb > 0) msg += ` (freed ${results.space_freed_mb} MB)`;
  console.error(msg);
} else {
  console.error('No cleanup needed');
}

console.log(JSON.stringify({ entries: [], metadata: results }));
