import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeRunTimes, latestRunSlot, decide } from '../plugins/roles/schedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const READ_JS = path.join(REPO_ROOT, 'plugins', 'roles', 'read.js');
const REPORT_JS = path.join(REPO_ROOT, 'plugins', 'roles', 'report.js');

// Environment for child scripts without the GIT_*/DOTENV* variables a hook or
// dotenvx run would add.
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('DOTENV') && key !== 'TODAY_ROLES_RUN'));
  return { ...env, ...extra };
}

describe('roles schedule', () => {
  test('normalizeRunTimes drops invalid times, dedupes, and sorts', () => {
    expect(normalizeRunTimes(['16:00', '04:00', 'noon', '25:00', '08:00', '04:00'])).toEqual(['04:00', '08:00', '16:00']);
    expect(normalizeRunTimes(undefined)).toEqual([]);
  });

  test('latestRunSlot picks today\'s latest passed time in the configured zone', () => {
    // 14:30 UTC is 10:30 in New York (EDT).
    const now = new Date('2026-10-09T14:30:00Z');
    expect(latestRunSlot(now, ['04:00', '08:00', '12:00', '16:00'], 'America/New_York')).toBe('2026-10-09 08:00');
  });

  test('latestRunSlot falls back to yesterday\'s last time before the first run of the day', () => {
    // 06:00 UTC is 02:00 in New York, before the 04:00 run.
    const now = new Date('2026-10-09T06:00:00Z');
    expect(latestRunSlot(now, ['04:00', '16:00'], 'America/New_York')).toBe('2026-10-08 16:00');
  });

  test('latestRunSlot is null without valid run times', () => {
    expect(latestRunSlot(new Date(), [], 'UTC')).toBeNull();
  });

  test('decide covers every action', () => {
    const slot = '2026-10-09 08:00';
    expect(decide(null, null).action).toBe('wait');
    expect(decide(slot, null).action).toBe('initialize');
    expect(decide(slot, { lastSlot: slot }).action).toBe('wait');
    expect(decide(slot, { lastSlot: '2026-10-09 04:00', pid: 123 }, { isAlive: () => true }).action).toBe('skip');
    expect(decide(slot, { lastSlot: '2026-10-09 04:00', pid: 123 }, { isAlive: () => false }).action).toBe('start');
    expect(decide(slot, { lastSlot: '2026-10-09 04:00' }).action).toBe('start');
  });
});

describe('roles plugin read.js', () => {
  let root;
  let configPath;

  beforeEach(() => {
    // A stand-in project root: read.js starts <root>/bin/today, so a fake one
    // records its arguments instead of running an AI session.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-plugin-'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'today'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/../args.txt"\necho "role env: $TODAY_ROLES_RUN" >> "$(dirname "$0")/../args.txt"\n');
    fs.chmodSync(path.join(root, 'bin', 'today'), 0o755);
    fs.mkdirSync(path.join(root, 'vault', 'roles', 'chief-of-staff'), { recursive: true });
    fs.writeFileSync(path.join(root, 'vault', 'roles', 'chief-of-staff', 'SKILL.md'), '# Chief of Staff\n');
    configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, 'timezone = "UTC"\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const statePath = () => path.join(root, '.data', 'roles', 'roles_default.json');

  function runRead(extraEnv = {}) {
    const result = spawnSync(process.execPath, [READ_JS], {
      env: cleanEnv({
        PROJECT_ROOT: root,
        VAULT_PATH: 'vault',
        SOURCE_ID: 'roles/default',
        TODAY_CONFIG: configPath,
        PLUGIN_CONFIG: JSON.stringify({ run_times: ['00:00'] }),
        ...extraEnv
      }),
      encoding: 'utf8'
    });
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
  }

  function waitForFile(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('role env')) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    throw new Error(`${file} never appeared`);
  }

  test('the first sync waits for the next run time instead of starting a run', () => {
    const { status, json } = runRead();
    expect(status).toBe(0);
    expect(json.started).toBe(false);
    expect(JSON.parse(fs.readFileSync(statePath(), 'utf8')).lastSlot).toMatch(/^\d{4}-\d{2}-\d{2} 00:00$/);
    expect(fs.existsSync(path.join(root, 'args.txt'))).toBe(false);
  });

  test('a due run starts the chief of staff in the background', () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ lastSlot: '2000-01-01 00:00' }));

    const { status, json } = runRead();

    expect(status).toBe(0);
    expect(json.started).toBe(true);
    waitForFile(path.join(root, 'args.txt'));
    const args = fs.readFileSync(path.join(root, 'args.txt'), 'utf8');
    expect(args).toContain('--non-interactive');
    expect(args).toContain('--no-sync');
    expect(args).toContain('Read vault/roles/chief-of-staff/SKILL.md and follow it.');
    expect(args).toContain('role env: 1');
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    expect(state.pid).toBe(json.pid);
    expect(state.lastSlot).not.toBe('2000-01-01 00:00');
  });

  test('a run still going makes the next run time skip', () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ lastSlot: '2000-01-01 00:00', pid: process.pid, startedAt: 'earlier' }));

    const { json } = runRead();

    expect(json.started).toBe(false);
    expect(json.reason).toMatch(/still going/);
    expect(fs.existsSync(path.join(root, 'args.txt'))).toBe(false);
  });

  test('a run never starts another run from inside its own session', () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ lastSlot: '2000-01-01 00:00' }));

    const { json } = runRead({ TODAY_ROLES_RUN: '1' });

    expect(json.skipped).toBe('inside a roles run');
    expect(fs.existsSync(path.join(root, 'args.txt'))).toBe(false);
  });

  test('a missing chief-of-staff file is an error that names the fix', () => {
    fs.rmSync(path.join(root, 'vault', 'roles'), { recursive: true });
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ lastSlot: '2000-01-01 00:00' }));

    const { status, stderr } = runRead();

    expect(status).toBe(1);
    expect(stderr).toMatch(/vault-files --install/);
  });
});

describe('roles plugin report.js', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-report-'));
    fs.mkdirSync(path.join(dir, 'vault', 'diary'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runReport(enabled) {
    // The vault path is resolved against the repository root, so it is given
    // relative to it even though it lives in a temp directory.
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, [
      `vault_path = ${JSON.stringify(path.relative(REPO_ROOT, path.join(dir, 'vault')))}`,
      'timezone = "UTC"',
      '',
      '[plugins.roles.default]',
      `enabled = ${enabled}`,
      ''
    ].join('\n'));
    return spawnSync(process.execPath, [REPORT_JS, 'cpa', 'Books balanced.', '--date', '2026-10-09'], {
      env: cleanEnv({ TODAY_CONFIG: configPath }),
      encoding: 'utf8'
    });
  }

  test('refuses when the roles plugin is not enabled', () => {
    const result = runReport(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/roles plugin is not enabled/);
    expect(fs.existsSync(path.join(dir, 'vault', 'diary', '2026-10-09.md'))).toBe(false);
  });

  test('writes the report when the plugin is enabled', () => {
    const result = runReport(true);
    expect(result.status).toBe(0);
    const diary = fs.readFileSync(path.join(dir, 'vault', 'diary', '2026-10-09.md'), 'utf8');
    expect(diary).toContain('<!-- ROLE:cpa:START -->');
    expect(diary).toContain('Books balanced.');
  });
});
