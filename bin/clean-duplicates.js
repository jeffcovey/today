#!/usr/bin/env node

// DEPRECATED: This script uses task-id which is no longer used
// We've transitioned to Obsidian Tasks syntax
// Duplicate detection should now be handled differently

import { autoDotenvx } from './lib/dotenvx-loader.js';
autoDotenvx();

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';

const dbPath = '.data/today.db';
const db = new Database(dbPath);

// Find all duplicate tasks (same title appearing multiple times)
console.log('Finding duplicate tasks...');
const duplicates = db.prepare(`
  SELECT title, COUNT(*) as count 
  FROM tasks 
  GROUP BY title 
  HAVING count > 1
  ORDER BY count DESC
`).all();

console.log(`Found ${duplicates.length} titles with duplicates`);

// For each duplicate, keep the oldest one and get IDs of ones to delete
const taskIdsToDelete = [];
const legitTaskIds = new Set();

for (const dup of duplicates) {
  // Get all tasks with this title
  const tasks = db.prepare(`
    SELECT id, created_at, status
    FROM tasks 
    WHERE title = ?
    ORDER BY created_at ASC
  `).all(dup.title);
  
  // Keep the first one (oldest)
  if (tasks.length > 0) {
    legitTaskIds.add(tasks[0].id);
    
    // Mark the rest for deletion
    for (let i = 1; i < tasks.length; i++) {
      taskIdsToDelete.push(tasks[i].id);
    }
  }
}

// Also keep these legitimate task IDs
const mustKeepIds = [
  'r14-investigate', 'r14-fix', 'r14-deploy',
  'ogm-update-810', 'member-responses',
  'railway-debug', 'railway-fix',
  'notion-mehul', 'github-pr',
  '981fd050eca3144eaa22d1331e051aa6',
  'e4c2a3848c390a70d77c30fb8c75e1f3',
  '6fe51efe7e716b1e21ed9958d5227514',
  'b020901682ffd4f8c1cf861226340dc1',
  '420ebf0461e459170976dd15b3571b46',
  'a', 'b', 'ac', 'f', 'e'
];

// Remove must-keep IDs from deletion list
const finalDeleteIds = taskIdsToDelete.filter(id => !mustKeepIds.includes(id));

console.log(`Will delete ${finalDeleteIds.length} duplicate tasks from database`);

// Delete from database
if (finalDeleteIds.length > 0) {
  const placeholders = finalDeleteIds.map(() => '?').join(',');
  const deleteStmt = db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`);
  const result = deleteStmt.run(...finalDeleteIds);
  console.log(`Deleted ${result.changes} tasks from database`);
}

// Now clean up markdown files
console.log('\nCleaning markdown files...');
const mdFiles = await glob('vault/**/*.md', { ignore: ['vault/.stversions/**'] });

for (const mdFile of mdFiles) {
  let content = fs.readFileSync(mdFile, 'utf-8');
  const originalLength = content.length;
  let modified = false;
  
  // Remove lines containing any of the deleted task IDs
  for (const taskId of finalDeleteIds) {
    const regex = new RegExp(`^.*<!-- task-id: ${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -->.*$`, 'gm');
    const newContent = content.replace(regex, '');
    if (newContent !== content) {
      content = newContent;
      modified = true;
    }
  }
  
  // Clean up multiple consecutive blank lines
  if (modified) {
    content = content.replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(mdFile, content);
    console.log(`  Cleaned ${path.basename(mdFile)} (removed ${originalLength - content.length} chars)`);
  }
}

console.log('\nDone! Run "bin/tasks sync" to regenerate clean markdown files.');
db.close();