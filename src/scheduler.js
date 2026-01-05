#!/usr/bin/env node

import cron from 'node-cron';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTimezone } from './config.js';

const execAsync = promisify(exec);
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
  }
];

/**
 * Service-specific maintenance jobs (auto-enabled when service is running)
 */
const SERVICE_MAINTENANCE_JOBS = {
  'resilio-sync': {
    name: 'resilio-sync-restart',
    schedule: '0 */2 * * *', // Every 2 hours
    command: 'systemctl restart resilio-sync || true',
    description: 'Restart Resilio Sync to prevent stale connections'
  },
  'vault-watcher': {
    name: 'vault-watcher-restart',
    schedule: '0 4 * * *', // Daily at 4 AM
    command: 'systemctl restart vault-watcher || true',
    description: 'Restart vault-watcher to ensure latest code'
  }
};

/**
 * Check which services are enabled
 */
function getEnabledServices() {
  const configPath = path.join(PROJECT_ROOT, '.data', 'services-config.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
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
  for (const [service, job] of Object.entries(SERVICE_MAINTENANCE_JOBS)) {
    if (services[service]) {
      jobs.push(job);
      console.log(`📋 Added ${service} maintenance job`);
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

async function runCommand(command, description) {
  // Check if sync is disabled due to missing data
  if (fs.existsSync(path.join(PROJECT_ROOT, 'SYNC_DISABLED')) && command.includes('sync')) {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] SKIPPED: ${description}`);
    console.log(`⚠️  Sync is disabled to prevent data loss. Check GitHub repository.`);
    return;
  }

  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Running: ${description}`);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: PROJECT_ROOT,
      env: process.env,
      shell: '/bin/sh',
      timeout: 10 * 60 * 1000 // 10 minute timeout
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
    runCommand(job.command, job.description);
  });
});

console.log(`\n✨ Scheduler running with ${jobs.length} job(s)`);
console.log('Press Ctrl+C to stop\n');

process.on('SIGTERM', () => {
  console.log('\n👋 Scheduler shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n👋 Scheduler interrupted, shutting down...');
  process.exit(0);
});
