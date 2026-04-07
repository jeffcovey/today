#!/usr/bin/env node

/**
 * Vault Snapshot Plugin - Sync Command
 *
 * Creates Time Machine-style incremental backups of the vault using rsync.
 * Each snapshot is stored in a timestamped subdirectory and hard-linked
 * against the previous snapshot so unchanged files share disk space.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

// Resolve snapshot directory (expand ~)
const rawSnapshotDir = config.snapshot_dir || '~/vault-snapshots';
const snapshotDir = rawSnapshotDir.startsWith('~')
  ? path.join(os.homedir(), rawSnapshotDir.slice(1))
  : rawSnapshotDir;

const keep = Number(config.keep ?? 30);

// Source directory to snapshot
const vaultDirectory = config.vault_directory || 'vault';
const sourceDir = path.join(projectRoot, vaultDirectory);

/**
 * List existing snapshot directories sorted oldest-first.
 * Snapshots are named YYYY-MM-DDTHH-MM-SS (ISO timestamp with colons replaced).
 */
function listSnapshots() {
  if (!fs.existsSync(snapshotDir)) {
    return [];
  }
  return fs
    .readdirSync(snapshotDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort(); // lexicographic sort works for ISO timestamps
}

/**
 * Create snapshot directory name from current time.
 */
function makeTimestamp() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
}

/**
 * Run rsync to create a new snapshot.
 * Uses --link-dest to hard-link unchanged files from the latest snapshot.
 */
function createSnapshot(destDir, linkDest) {
  // Ensure trailing slash on source so rsync copies contents, not the dir itself
  const src = sourceDir.endsWith('/') ? sourceDir : `${sourceDir}/`;

  const args = [
    '-a',            // archive mode (preserves permissions, timestamps, symlinks, etc.)
    '--delete',      // remove files in dest that no longer exist in source
  ];

  if (linkDest) {
    args.push(`--link-dest=${linkDest}`);
  }

  args.push(src, destDir);

  const result = spawnSync('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('rsync command not found. Please install rsync and ensure it is on PATH.');
    }
    throw new Error(`rsync failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || '';
    throw new Error(`rsync exited with status ${result.status}: ${stderr}`);
  }
}

/**
 * Update (or create) the `latest` symlink inside snapshotDir to point at newSnapshot.
 */
function updateLatestSymlink(newSnapshotName) {
  const latestLink = path.join(snapshotDir, 'latest');
  try {
    // lstat does not follow symlinks, so this detects dangling symlinks too
    fs.lstatSync(latestLink);
    fs.unlinkSync(latestLink);
  } catch {
    // does not exist yet — nothing to remove
  }
  fs.symlinkSync(newSnapshotName, latestLink);
}

/**
 * Remove old snapshots beyond the `keep` limit.
 */
function pruneOldSnapshots(snapshots) {
  // snapshots is the list BEFORE the new snapshot was created.
  // After adding the new one the total is snapshots.length + 1.
  // We want at most `keep` snapshots total, so remove the oldest ones.
  const excess = snapshots.length + 1 - keep;
  const toRemove = excess > 0 ? snapshots.slice(0, excess) : [];
  for (const name of toRemove) {
    const dir = path.join(snapshotDir, name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return toRemove;
}

function sync() {
  // Validate that the source directory exists
  if (!fs.existsSync(sourceDir)) {
    console.log(JSON.stringify({
      cleaned: 0,
      message: `Source directory not found: ${sourceDir}`
    }));
    return;
  }

  // Ensure snapshot directory exists
  fs.mkdirSync(snapshotDir, { recursive: true });

  const existingSnapshots = listSnapshots();
  const latestLink = path.join(snapshotDir, 'latest');
  const hasLatest = fs.existsSync(latestLink);

  const timestamp = makeTimestamp();
  const destDir = path.join(snapshotDir, timestamp);

  // Determine link-dest: prefer the `latest` symlink (resolves to the actual path),
  // fall back to the most recent snapshot directory by name.
  let linkDest = null;
  if (hasLatest) {
    // Resolve to absolute path for --link-dest
    linkDest = fs.realpathSync(latestLink);
  } else if (existingSnapshots.length > 0) {
    linkDest = path.join(snapshotDir, existingSnapshots[existingSnapshots.length - 1]);
  }

  createSnapshot(destDir, linkDest);
  updateLatestSymlink(timestamp);

  const removed = pruneOldSnapshots(existingSnapshots);
  const totalSnapshots = existingSnapshots.length + 1 - removed.length;

  const isIncremental = linkDest !== null;
  console.log(JSON.stringify({
    cleaned: removed.length,
    message: isIncremental
      ? `Incremental snapshot created: ${timestamp} (${totalSnapshots} total, ${removed.length} pruned)`
      : `Full snapshot created: ${timestamp}`,
    snapshot: timestamp,
    snapshotDir,
    totalSnapshots,
    pruned: removed.length
  }));
}

sync();
