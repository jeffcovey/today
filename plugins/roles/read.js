#!/usr/bin/env node

/**
 * Roles plugin: on each sync, start a chief-of-staff run when one of the
 * configured run times has passed since the last run.
 *
 * The run is started as a detached process with its own process group and
 * this script returns at once, so the plugin loader's timeout never applies
 * to it: the run takes as long as it needs. Its output goes to
 * .data/roles/<source>.log.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getTimezone } from '../../src/config.js';
import { decide, latestRunSlot } from './schedule.js';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const vaultPath = process.env.VAULT_PATH || 'vault';
const sourceId = process.env.SOURCE_ID || 'roles/default';

const runTimes = config.run_times ?? ['08:00', '13:00', '17:00'];
const rolesDirectory = config.roles_directory || 'roles';
const chiefRole = config.chief_role || 'chief-of-staff';

const stateDir = path.join(projectRoot, '.data', 'roles');
const sourceStem = sourceId.replace(/[^a-z0-9-]+/gi, '_');
const statePath = path.join(stateDir, `${sourceStem}.json`);
const logPath = path.join(stateDir, `${sourceStem}.log`);

function output(result) {
  console.log(JSON.stringify(result));
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

function startRun(chiefSkillPath, timeZone) {
  fs.mkdirSync(stateDir, { recursive: true });
  const log = fs.openSync(logPath, 'w');

  const env = { ...process.env, TODAY_ROLES_RUN: '1', TZ: timeZone };
  for (const key of Object.keys(env)) {
    if (key === 'PLUGIN_CONFIG' || key === 'SOURCE_ID') {
      delete env[key];
    }
  }

  const child = spawn(
    path.join(projectRoot, 'bin', 'today'),
    ['--non-interactive', '--no-sync', '--quiet', `Read ${chiefSkillPath} and follow it.`],
    { cwd: projectRoot, env, detached: true, stdio: ['ignore', log, log] }
  );
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

function main() {
  if (process.env.CONTEXT_ONLY === 'true') {
    output({ skipped: 'context-only' });
    return;
  }
  // A run's own bin/today session must never start another run.
  if (process.env.TODAY_ROLES_RUN === '1') {
    output({ skipped: 'inside a roles run' });
    return;
  }

  const timeZone = getTimezone();
  const slot = latestRunSlot(new Date(), runTimes, timeZone);
  const state = readState();
  const { action, reason } = decide(slot, state);

  if (action === 'wait') {
    output({ started: false, reason });
    return;
  }

  if (action === 'initialize') {
    writeState({ lastSlot: slot });
    output({ started: false, reason });
    return;
  }

  if (action === 'skip') {
    writeState({ ...state, lastSlot: slot });
    output({ started: false, reason });
    return;
  }

  const chiefSkillPath = path.join(vaultPath, rolesDirectory, chiefRole, 'SKILL.md');
  if (!fs.existsSync(path.resolve(projectRoot, chiefSkillPath))) {
    console.error(JSON.stringify({
      error: `${chiefSkillPath} not found; run bin/plugins vault-files --install, or set chief_role / roles_directory`
    }));
    process.exit(1);
  }

  const pid = startRun(chiefSkillPath, timeZone);
  const startedAt = new Date().toISOString();
  writeState({ lastSlot: slot, pid, startedAt });
  output({ started: true, slot, pid, startedAt, log: path.relative(projectRoot, logPath), reason });
}

main();
