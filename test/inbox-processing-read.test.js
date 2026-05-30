import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const readScript = path.join(repoRoot, 'plugins', 'inbox-processing', 'read.js');

// ISO timestamp (no millis) offset from now by the given number of seconds.
function isoAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function logFileNameForNow() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.md`;
}

function runReadPlugin(projectRoot, pluginConfig = {}) {
  const result = spawnSync('node', [readScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      VAULT_PATH: path.join(projectRoot, 'vault'),
      SOURCE_ID: 'inbox-processing/test',
      PLUGIN_CONFIG: JSON.stringify({
        inbox_directory: 'vault/inbox',
        ...pluginConfig
      })
    }
  });
  const output = (result.stdout || '').trim();
  return JSON.parse(output.split('\n').pop());
}

describe('inbox-processing time-tracking marker cleanup', () => {
  let tempRoot;
  let inboxDir;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-processing-read-'));
    inboxDir = path.join(tempRoot, 'vault', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  let counter = 0;
  function marker(action, timestamp, description) {
    const name = `time-tracking-${Date.now()}-${counter++}.txt`;
    fs.writeFileSync(path.join(inboxDir, name), `${action}\n${timestamp}\n${description}\n`);
    return name;
  }

  // Time-tracking marker files still sitting at the top of the inbox (not trashed).
  function remainingMarkers() {
    return fs.readdirSync(inboxDir).filter(f => f.startsWith('time-tracking-'));
  }

  function readLogLines() {
    const logFile = path.join(tempRoot, 'vault', 'logs', 'time-tracking', logFileNameForNow());
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
  }

  test('collapses same-second multi-device duplicate Starts and pairs one session', () => {
    const ts = isoAgo(600); // 10 min ago
    marker('Start', ts, 'Accounting');
    marker('Start', ts, 'Accounting');
    marker('Start', ts, 'Accounting');
    marker('Stop', isoAgo(0), 'Accounting');

    const result = runReadPlugin(tempRoot);

    expect(result.timeTrackingSessions).toBe(1);
    expect(remainingMarkers()).toHaveLength(0); // all four files trashed, none orphaned
    expect(readLogLines()).toHaveLength(1);
  });

  test('collapses Starts fired seconds apart, keeping the earliest start time', () => {
    const early = isoAgo(617);
    const late = isoAgo(600); // 17s later
    marker('Start', late, 'Accounting');
    marker('Start', early, 'Accounting');
    marker('Stop', isoAgo(0), 'Accounting');

    const result = runReadPlugin(tempRoot);

    expect(result.timeTrackingSessions).toBe(1);
    expect(remainingMarkers()).toHaveLength(0);
    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].split('|')[0]).toBe(early); // earliest start wins
  });

  test('does NOT merge different activities within the window', () => {
    const t = isoAgo(600);
    marker('Start', t, 'Accounting');
    marker('Start', isoAgo(595), 'Email'); // 5s later, different description
    marker('Stop', isoAgo(60), 'Accounting');
    marker('Stop', isoAgo(0), 'Email');

    const result = runReadPlugin(tempRoot);

    expect(result.timeTrackingSessions).toBe(2); // two distinct sessions, not collapsed
    expect(remainingMarkers()).toHaveLength(0);
    expect(readLogLines()).toHaveLength(2);
  });

  test('ages out an unpaired Start older than the cutoff', () => {
    marker('Start', isoAgo(72 * 3600), 'Reading'); // 72h ago, no Stop

    const result = runReadPlugin(tempRoot, { max_unpaired_start_age_hours: 48 });

    expect(result.timeTrackingSessions).toBe(0);
    expect(remainingMarkers()).toHaveLength(0); // aged out and trashed
  });

  test('keeps a recent unpaired Start for a future Stop', () => {
    marker('Start', isoAgo(3600), 'Reading'); // 1h ago, no Stop

    const result = runReadPlugin(tempRoot, { max_unpaired_start_age_hours: 48 });

    expect(result.timeTrackingSessions).toBe(0);
    expect(remainingMarkers()).toHaveLength(1); // still waiting for its Stop
  });

  test('trashes an orphaned Stop with no matching Start', () => {
    marker('Stop', isoAgo(0), 'Reading');

    const result = runReadPlugin(tempRoot);

    expect(result.timeTrackingSessions).toBe(0);
    expect(remainingMarkers()).toHaveLength(0);
  });
});
