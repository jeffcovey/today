#!/usr/bin/env node

import cron from 'node-cron';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTimezone, getConfig } from './config.js';
import { execGroup } from './process-group.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.dirname(__dirname);

// Set timezone from config.toml BEFORE any scheduling
const configuredTimezone = getTimezone();
process.env.TZ = configuredTimezone;

console.log('📅 Today Scheduler starting...');
console.log(`Timezone: ${configuredTimezone} (from config.toml)`);
console.log(`Current time: ${new Date().toLocaleString('en-US', { timeZone: configuredTimezone })}`);

/**
 * Built-in maintenance jobs (always run when scheduler is enabled)
 */
const MAINTENANCE_JOBS = [
  {
    name: 'system-maintenance',
    schedule: '0 */6 * * *', // Every 6 hours
    command: 'bin/deploy maintenance --local || true',
    description: 'System maintenance (cleanup logs, check disk, database)'
  },
  {
    name: 'prerender-markdown',
    schedule: '*/30 * * * *', // Every 30 minutes
    command: 'bin/prerender',
    description: 'Pre-render vault markdown files to disk HTML cache'
  },
  {
    name: 'unison-sync-healthcheck',
    schedule: '*/5 * * * *', // Every 5 minutes
    command: 'bin/unison-sync-healthcheck',
    // Placed in MAINTENANCE_JOBS (always-on) rather than SERVICE_MAINTENANCE_JOBS
    // because Unison runs as a Docker container, not a systemd service, so the
    // `systemctl is-active` gate used for resilio-sync doesn't apply. The
    // no-status-file guard inside the script makes it a safe no-op on any
    // deployment that has never run unison-sync.
    description: 'Check Unison sync is running and surface failures in the vault'
  }
];

/**
 * Service-specific maintenance jobs (auto-enabled when service is running)
 */
const SERVICE_MAINTENANCE_JOBS = {
  'resilio-sync': [
    {
      name: 'resilio-sync-healthcheck',
      schedule: '*/5 * * * *', // Every 5 minutes
      command: 'bin/resilio-healthcheck',
      description: 'Check Resilio Sync peer connectivity'
    },
    {
      name: 'resilio-sync-restart',
      schedule: '0 */12 * * *', // Every 12 hours
      command: 'systemctl restart resilio-sync || true',
      description: 'Restart Resilio Sync to prevent stale connections'
    }
  ]
};

/**
 * Check which services are enabled
 * Reads from config file if present, then also checks systemctl for running services
 */
function getEnabledServices() {
  const services = {};

  // Read config file if present
  const configPath = path.join(PROJECT_ROOT, '.data', 'services-config.json');
  if (fs.existsSync(configPath)) {
    try {
      Object.assign(services, JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } catch {
      // ignore
    }
  }

  // Also detect running services via systemctl
  for (const service of Object.keys(SERVICE_MAINTENANCE_JOBS)) {
    if (!services[service]) {
      try {
        execSync(`systemctl is-active --quiet ${service}`, { stdio: 'pipe' });
        services[service] = true;
      } catch {
        // not running
      }
    }
  }

  return services;
}

/**
 * Load jobs from scheduler config file or use defaults
 */
function loadJobs() {
  const jobs = [];

  // 1. Add built-in maintenance jobs (always run)
  jobs.push(...MAINTENANCE_JOBS);
  console.log(`📋 Added ${MAINTENANCE_JOBS.length} maintenance job(s)`);

  // 2. Add service-specific maintenance jobs (auto-enabled when service is running)
  const services = getEnabledServices();
  for (const [service, serviceJobs] of Object.entries(SERVICE_MAINTENANCE_JOBS)) {
    if (services[service]) {
      const jobList = Array.isArray(serviceJobs) ? serviceJobs : [serviceJobs];
      jobs.push(...jobList);
      console.log(`📋 Added ${jobList.length} ${service} maintenance job(s)`);
    }
  }

  // 3. Load user-configured jobs from config file
  const configPath = path.join(PROJECT_ROOT, '.data', 'scheduler-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const userJobs = Object.entries(config).map(([name, job]) => ({
        name,
        schedule: job.schedule,
        command: job.command,
        description: job.description || name
      }));
      jobs.push(...userJobs);
      console.log(`📋 Loaded ${userJobs.length} user-configured job(s)`);
    } catch (error) {
      console.error(`⚠️ Failed to load scheduler config: ${error.message}`);
    }
  } else {
    // Default user job if no config file
    console.log('📋 Using default plugin-sync job (no scheduler-config.json found)');
    jobs.push({
      name: 'plugin-sync',
      schedule: '*/10 * * * *',
      command: 'bin/plugins sync',
      description: 'Sync all plugins'
    });
  }

  return jobs;
}

// Max jitter in milliseconds added before each job to avoid thundering herd
// when multiple machines run the same schedule. 15s default keeps jobs within
// their cron window while spreading them out enough to avoid iCloud conflicts.
const JITTER_MS = (getConfig('scheduler_jitter_seconds') || 15) * 1000;

// How long a job may run before the scheduler tears down its process group.
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

// Jobs currently in flight. A cron tick for a job that is still running is
// skipped rather than stacked on top: overlapping `bin/plugins sync` runs
// contend for the same per-source locks and multiply the number of concurrent
// AI subprocesses. See issue #383. Held by job object rather than by name so a
// user-configured job that reuses a built-in name can't block it.
const runningJobs = new Set();

// Live process groups, so shutdown can take them with us instead of leaving
// orphans behind.
const activeGroups = new Set();

async function runCommand(command, description) {
  // Check if sync is disabled due to missing data
  if (fs.existsSync(path.join(PROJECT_ROOT, 'SYNC_DISABLED')) && command.includes('sync')) {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] SKIPPED: ${description}`);
    console.log(`⚠️  Sync is disabled to prevent data loss. Check GitHub repository.`);
    return;
  }

  // Random jitter to avoid multiple machines firing the same job simultaneously
  if (JITTER_MS > 0) {
    const delay = Math.floor(Math.random() * JITTER_MS);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Running: ${description}`);

  let group = null;
  try {
    const { stdout, stderr } = await execGroup(command, {
      cwd: PROJECT_ROOT,
      env: process.env,
      timeoutMs: JOB_TIMEOUT_MS,
      onSpawn: (handle) => {
        group = handle;
        activeGroups.add(handle);
      }
    });

    if (stdout) {
      console.log(`✅ ${description} completed:`);
      console.log(stdout.trim().split('\n').slice(-5).join('\n')); // Last 5 lines
    }

    if (stderr) {
      console.error(`⚠️ Warnings from ${description}:`);
      console.error(stderr);
    }
  } catch (error) {
    console.error(`❌ ${description} failed:`, error.message);
  } finally {
    if (group) activeGroups.delete(group);
  }
}

// Load and schedule jobs
const jobs = loadJobs();

if (jobs.length === 0) {
  console.log('⚠️ No jobs configured. Add jobs to config.toml under [deployments.*.jobs]');
  process.exit(0);
}

jobs.forEach(job => {
  if (!cron.validate(job.schedule)) {
    console.error(`❌ Invalid cron schedule for ${job.name}: ${job.schedule}`);
    return;
  }

  console.log(`📌 Scheduled: ${job.description} - ${job.schedule}`);

  cron.schedule(job.schedule, () => {
    if (runningJobs.has(job)) {
      const timestamp = new Date().toISOString();
      console.log(`\n[${timestamp}] SKIPPED: ${job.description}`);
      console.log('⏭️  Previous run is still in progress.');
      return;
    }

    runningJobs.add(job);
    runCommand(job.command, job.description).finally(() => {
      runningJobs.delete(job);
    });
  });
});

console.log(`\n✨ Scheduler running with ${jobs.length} job(s)`);
console.log('Press Ctrl+C to stop\n');

// Detached children outlive their parent by design, so shutdown has to signal
// them explicitly or a scheduler restart leaves the previous run's tree behind.
function shutdown(message) {
  console.log(`\n👋 ${message}`);
  for (const group of activeGroups) {
    group.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('Scheduler shutting down gracefully...'));
process.on('SIGINT', () => shutdown('Scheduler interrupted, shutting down...'));
