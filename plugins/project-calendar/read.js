#!/usr/bin/env node

// Project Calendar Plugin - Read/Sync Command
// Delegates to "bin/calendar sync-projects <source>" which uses the existing
// calendar plugin infrastructure (credentials, write.js) for the target source.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = process.env.PROJECT_ROOT || path.resolve(__dirname, '../..');

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const calendarSource = config.calendar_source;

if (!calendarSource) {
  console.log(JSON.stringify({ entries: [], files_processed: [], incremental: false, error: 'No calendar_source configured' }));
  process.exit(1);
}

try {
  const out = execSync('node bin/calendar sync-projects ' + JSON.stringify(calendarSource), {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  // Print progress to stderr so it's visible in the console but doesn't corrupt the JSON output
  if (out) process.stderr.write(out);
} catch (err) {
  const msg = (err.stderr?.trim() || err.stdout?.trim() || err.message);
  if (err.stderr) process.stderr.write(err.stderr);
  console.log(JSON.stringify({ entries: [], files_processed: [], incremental: false, error: msg }));
  process.exit(1);
}

// Read the mapping file to know which projects were successfully synced
const mappingSuffix = calendarSource.replace(/[^a-zA-Z0-9_-]/g, '-');
const mappingFile = path.join(projectRoot, '.data', `project-calendar-${mappingSuffix}.json`);
let mapping = {};
try { mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8')); } catch { /* first run */ }

// Build local event entries from successfully-synced projects
const db = new Database(path.join(projectRoot, '.data', 'today.db'), { readonly: true });
const projects = db.prepare(`
  SELECT id, title, start_date, due_date, url
  FROM projects
  WHERE status IN ('active', 'planning') AND due_date IS NOT NULL
  ORDER BY due_date
`).all();
db.close();

const entries = projects
  .filter(p => mapping[p.id])
  .map(p => ({
    id: `project-calendar/${mappingSuffix}:${p.id}`,
    calendar_name: 'Projects',
    title: p.title,
    start_date: p.start_date || p.due_date,
    end_date: (() => { const d = new Date(p.due_date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })(),
    start_timezone: null,
    end_timezone: null,
    location: null,
    description: p.url || null,
    all_day: true,
  }));

console.log(JSON.stringify({ entries, files_processed: [calendarSource], incremental: false }));
