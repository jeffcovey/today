#!/usr/bin/env node

import cron from 'node-cron';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { getTimezone } from './config.js';

const execAsync = promisify(exec);

// Set timezone from config.toml BEFORE any scheduling
// This ensures cron jobs run in the configured timezone
const configuredTimezone = getTimezone();
process.env.TZ = configuredTimezone;

console.log('📅 Today Scheduler starting...');
console.log(`Timezone: ${configuredTimezone} (from config.toml)`);
console.log(`Current time: ${new Date().toLocaleString('en-US', { timeZone: configuredTimezone })}`);

async function runCommand(command, description) {
    // Check if sync is disabled due to missing data
    if (fs.existsSync('/app/SYNC_DISABLED') && command.includes('sync')) {
        const timestamp = new Date().toISOString();
        console.log(`\n[${timestamp}] SKIPPED: ${description}`);
        console.log(`⚠️  Sync is disabled to prevent data loss. Check GitHub repository.`);
        return;
    }

    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Running: ${description}`);

    try {
        // Use the correct working directory - /opt/today on DigitalOcean, /app on Fly
        const cwd = fs.existsSync('/opt/today') ? '/opt/today' : '/app';

        const { stdout, stderr } = await execAsync(command, {
            cwd: cwd,
            env: process.env,
            shell: '/usr/bin/sh', // Explicitly use /usr/bin/sh instead of /bin/sh
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

const jobs = [
    {
        schedule: '*/10 * * * *', // Every 10 minutes
        command: 'bin/plugins sync || true', // Sync all plugins
        description: 'Plugin sync'
    },
    // TODO: Re-enable after bin/today is updated (see #73)
    // {
    //     schedule: '0 6,8,10,12,14,16,18,20 * * *', // Every 2 hours on the hour - 6AM, 8AM, 10AM, 12PM, 2PM, 4PM, 6PM, 8PM EST
    //     command: 'bin/today update || true',
    //     description: 'Update today and tomorrow daily plans with Claude API'
    // },
    // Removed: bin/vault-snapshot - see #75 for plugin migration
    // Removed: bin/vault-auto-sync - legacy, replaced by Resilio Sync
    // Removed: journalctl cleanup - handled by bin/droplet-maintenance
    // Removed: bin/tasks update-cache - legacy, task cache no longer used
    // TODO: Review vault-watcher restart (see #76)
    // {
    //     schedule: '0 4 * * *', // Daily at 4 AM EST
    //     command: 'systemctl restart vault-watcher || true',
    //     description: 'Restart vault-watcher to ensure latest code'
    // },
    {
        schedule: '0 */6 * * *', // Every 6 hours EST
        command: 'bin/droplet-maintenance || true',
        description: 'Droplet maintenance (cleanup logs, check processes)'
    },
    {
        schedule: '0 */2 * * *', // Every 2 hours EST
        command: 'systemctl restart resilio-sync || true',
        description: 'Restart Resilio Sync to prevent stale connections'
    },
    // TODO: Re-enable after inbox processing is updated (see #74)
    // {
    //     schedule: '*/15 * * * *', // Every 15 minutes
    //     command: 'bin/droplet-monitor || true',
    //     description: 'Monitor droplet health'
    // },
    // Removed: bin/tasks archive-completed - moved to plugins (streaks-habits)
    // TODO: Review bin/email organize (see #77)
    // {
    //     schedule: '0 12 * * *', // Daily at 12 PM (noon) EST
    //     command: 'bin/email organize || true',
    //     description: 'Organize inbox emails by stage'
    // },
];

// Note: node-cron has known bugs with the timezone option (memory leaks, doesn't work properly)
// Instead, we set process.env.TZ from config.toml at startup (see above)
// This makes cron expressions run in the configured timezone automatically

jobs.forEach(job => {
    console.log(`📌 Scheduled: ${job.description} - ${job.schedule}`);

    cron.schedule(job.schedule, () => {
        runCommand(job.command, job.description);
    });
});

console.log(`\n✨ Scheduler running with ${jobs.length} jobs`);
console.log('Press Ctrl+C to stop\n');

process.on('SIGTERM', () => {
    console.log('\n👋 Scheduler shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n👋 Scheduler interrupted, shutting down...');
    process.exit(0);
});