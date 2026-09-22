import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getSqlColumns } from '../src/plugin-schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const trackBin = path.join(repoRoot, 'bin', 'track');

// The database path is resolved with path.resolve('.data/today.db'), i.e.
// against the working directory — so running bin/track from the temp root
// keeps this test off the repo's own database, which on a deployment is the
// live one. Everything else (plugin discovery, vault_path) resolves from the
// script location, so it is unaffected by the cwd.
function runTrack(cwd, configPath, args) {
  return spawnSync(process.execPath, [trackBin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      TODAY_CONFIG: configPath
    }
  });
}

describe('bin/track start syncs file-backed timers first', () => {
  let tempRoot;
  let configPath;
  let vaultPath;
  let sourceId;
  let dbPath;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'track-start-sync-'));
    dbPath = path.join(tempRoot, '.data', 'today.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS time_logs (${getSqlColumns('time-logs')})`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        source TEXT PRIMARY KEY,
        sync_locked_at TEXT,
        sync_locked_by TEXT,
        last_synced_at TEXT,
        last_sync_files TEXT,
        entries_count INTEGER,
        extra_data TEXT
      )
    `);
    db.close();

    vaultPath = path.join(tempRoot, 'vault');
    fs.mkdirSync(path.join(vaultPath, 'logs', 'time-tracking'), { recursive: true });

    const sourceName = path.basename(tempRoot);
    sourceId = `markdown-time-tracking/${sourceName}`;
    configPath = path.join(tempRoot, 'config.toml');
    fs.writeFileSync(configPath, [
      'timezone = "America/New_York"',
      `vault_path = "${path.relative(repoRoot, vaultPath)}"`,
      '',
      `[plugins.markdown-time-tracking.${sourceName}]`,
      'enabled = true',
      `directory = "${path.relative(repoRoot, path.join(vaultPath, 'logs', 'time-tracking'))}"`,
      ''
    ].join('\n'));
  });

  afterEach(() => {
    // Nothing shared is touched, so removing the temp root is the whole cleanup.
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('stops the synced running timer before starting the new one', () => {
    const timeDir = path.join(vaultPath, 'logs', 'time-tracking');
    const priorStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(timeDir, 'current-timer.md'),
      `Synced running timer #topic/original\n${priorStart}\n`
    );

    const result = runTrack(tempRoot, configPath, ['start', 'Replacement timer #topic/new']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Stopping previous timer: Synced running timer #topic/original');
    expect(result.stdout).toContain('Started: Replacement timer #topic/new');

    const monthPath = path.join(timeDir, `${priorStart.substring(0, 7)}.md`);
    expect(fs.readFileSync(monthPath, 'utf8')).toContain(`|Synced running timer #topic/original`);

    const currentTimer = fs.readFileSync(path.join(timeDir, 'current-timer.md'), 'utf8').trim().split('\n');
    expect(currentTimer[0]).toBe('Replacement timer #topic/new');
    expect(currentTimer[1]).toMatch(/T\d{2}:\d{2}:\d{2}/);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`
      SELECT description, end_time
      FROM time_logs
      WHERE source = ?
      ORDER BY start_time
    `).all(sourceId);
    db.close();

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        description: 'Synced running timer #topic/original'
      }),
      expect.objectContaining({
        description: 'Replacement timer #topic/new',
        end_time: null
      })
    ]));
    expect(rows.find(row => row.description === 'Synced running timer #topic/original').end_time).not.toBeNull();
  });
});
