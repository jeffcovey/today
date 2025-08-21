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
        const { stdout, stderr } = await execAsync(command, {
            cwd: '/app',
            env: process.env,
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
        schedule: '0 */2 5-21 * *', // Every 2 hours between 5AM and 9PM
        command: 'bin/today --no-sync "Update today\'s review file for the current time" || true',
        description: 'Update daily review with Claude',
        timezone: true
    },
    {
        schedule: '0 4 * * *', // Daily at 4 AM
        command: 'bin/sync || true', // Full sync (all data sources)
        description: 'Full data sync',
        timezone: true
    },
    {
        schedule: '0 3 * * *', // Daily at 3 AM (before full sync)
        command: 'bin/notion daily --all || true', // Run all Notion daily automation tasks
        description: 'Notion daily automation (temporary until migration)',
        timezone: true
    }
];

jobs.forEach(job => {
    const options = job.timezone ? { timezone: process.env.TZ || 'America/New_York' } : {};
    
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