#!/usr/bin/env node
import Database from 'better-sqlite3';
import chalk from 'chalk';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', '.data', 'today.db');
const db = new Database(dbPath);

console.log(chalk.blue('Finding duplicate tasks...'));

// Find all duplicates by title
const duplicates = db.prepare(`
  SELECT title, COUNT(*) as count 
  FROM tasks 
  GROUP BY title 
  HAVING count > 1 
  ORDER BY count DESC
`).all();

console.log(chalk.yellow(`Found ${duplicates.length} task titles with duplicates`));

let totalDeleted = 0;
const allToDelete = [];

for (const dup of duplicates) {
  // Get all tasks with this title
  const tasks = db.prepare(`
    SELECT id, title, status, created_at, updated_at, completed_at 
    FROM tasks 
    WHERE title = ? 
    ORDER BY 
      CASE WHEN completed_at IS NOT NULL THEN 0 ELSE 1 END,
      completed_at DESC,
      updated_at DESC,
      created_at DESC
  `).all(dup.title);
  
  if (tasks.length > 1) {
    // Keep the first one (most recently completed or updated)
    const keep = tasks[0];
    const toDelete = tasks.slice(1);
    
    console.log(chalk.gray(`  ${dup.title.substring(0, 50)}...: keeping 1, deleting ${toDelete.length}`));
    
    // Collect IDs to delete
    allToDelete.push(...toDelete.map(t => t.id));
    totalDeleted += toDelete.length;
  }
}

// Delete all duplicates in a single transaction
if (allToDelete.length > 0) {
  console.log(chalk.yellow(`Deleting ${allToDelete.length} duplicate tasks...`));
  const deleteStmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  const deleteTransaction = db.transaction((ids) => {
    for (const id of ids) {
      deleteStmt.run(id);
    }
  });
  
  deleteTransaction(allToDelete);
}

console.log(chalk.green(`✓ Deleted ${totalDeleted} duplicate tasks`));

// Verify no more duplicates
const remaining = db.prepare(`
  SELECT COUNT(*) as count 
  FROM (
    SELECT title, COUNT(*) as c 
    FROM tasks 
    GROUP BY title 
    HAVING c > 1
  )
`).get();

if (remaining.count === 0) {
  console.log(chalk.green('✓ No duplicates remain'));
} else {
  console.log(chalk.red(`⚠ ${remaining.count} duplicate titles still exist`));
}

db.close();