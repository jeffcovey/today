#!/usr/bin/env node

import cron from 'node-cron';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);

console.log('📅 Today Scheduler starting...');
console.log(`Timezone: ${process.env.TZ || 'UTC'}`);
console.log(`Current time: ${new Date().toLocaleString()}`);

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
        command: 'bin/sync --quick || true', // Quick sync (GitHub vault and tasks only)
        description: 'Quick sync'
    },
    {
        schedule: '30 * * * *', // Every hour at :30 (half past)
        command: 'bin/sync ; bin/tasks classify-stages ; bin/tasks prioritize-status ; bin/tasks add-topics ; bin/track add-topics || true', // Full sync + task management + time tracking
        description: 'Full sync, task management, and time tracking auto-tagging',
        timezone: true
    },
    {
        schedule: '0 6,8,10,12,14,16,18,20 * * *', // Every 2 hours on the hour - 6AM, 8AM, 10AM, 12PM, 2PM, 4PM, 6PM, 8PM EDT
        command: 'bin/today update || true',
        description: 'Update daily review with Claude API',
        timezone: true
    },
    {
        schedule: '0 3 * * *', // Daily at 3 AM
        command: 'bin/notion daily --all || true', // Run all Notion daily automation tasks
        description: 'Notion daily automation (temporary until migration)',
        timezone: true
    },
    {
        schedule: '0 2 * * *', // Daily at 2 AM
        command: 'bin/vault-snapshot || true', // Backup vault daily
        description: 'Daily vault snapshot backup',
        timezone: true
    },
    // {
    //     schedule: '*/5 * * * *', // Every 5 minutes
    //     command: 'bin/vault-auto-sync || true',
    //     description: 'Vault git sync'
    // },
    {
        schedule: '0 * * * *', // Every hour
        command: 'journalctl --vacuum-time=24h > /dev/null 2>&1 || true',
        description: 'Clean up old systemd logs'
    },
    {
        schedule: '0 4 * * *', // Daily at 4 AM
        command: 'systemctl restart vault-watcher || true',
        description: 'Restart vault-watcher to ensure latest code',
        timezone: true
    },
    {
        schedule: '15 * * * *', // Every hour at :15 (quarter past)
        command: 'bin/tasks update-cache || true',
        description: 'Refresh markdown tasks cache',
        timezone: false
    },
    {
        schedule: '0 */6 * * *', // Every 6 hours
        command: 'bin/droplet-maintenance || true',
        description: 'Droplet maintenance (cleanup logs, check processes)',
        timezone: false
    },
    {
        schedule: '*/15 * * * *', // Every 15 minutes
        command: 'bin/droplet-monitor || true',
        description: 'Monitor droplet health',
        timezone: false
    },
    {
        schedule: '0 1 * * *', // Daily at 1 AM
        command: 'bin/tasks archive-completed || true',
        description: 'Archive completed tasks',
        timezone: true
    }
];

import { getTimezone } from './config.js';

jobs.forEach(job => {
    const options = job.timezone ? { timezone: process.env.TZ || getTimezone() } : {};

    console.log(`📌 Scheduled: ${job.description} - ${job.schedule}`);

    cron.schedule(job.schedule, () => {
        runCommand(job.command, job.description);
    }, options);
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