#!/usr/bin/env node

import Database from 'better-sqlite3';

const db = new Database('.data/today.db');

console.log('Starting deduplication process...');

// First, let's see what we're dealing with
const totalBefore = db.prepare('SELECT COUNT(*) as count FROM tasks').get().count;
console.log(`Total tasks before deduplication: ${totalBefore}`);

// Find all duplicate groups
const duplicateGroups = db.prepare(`
  SELECT title, COUNT(*) as count 
  FROM tasks 
  WHERE title != '' AND title IS NOT NULL
  GROUP BY title 
  HAVING COUNT(*) > 1
`).all();

console.log(`Found ${duplicateGroups.length} groups of duplicates`);

let totalDuplicates = 0;
let keptTasks = 0;
let deletedTasks = 0;

// Process each duplicate group
db.exec('BEGIN TRANSACTION');

try {
  for (const group of duplicateGroups) {
    // Get all tasks with this title
    const duplicates = db.prepare(`
      SELECT 
        t.id,
        t.title,
        t.description,
        t.do_date,
        t.status,
        t.stage,
        t.created_at,
        t.completed_at,
        t.project_id,
        t.content,
        t.notion_id,
        t.notion_url,
        t.repeat_interval,
        t.repeat_next_date,
        (SELECT COUNT(*) FROM task_topics WHERE task_id = t.id) as topic_count,
        (SELECT COUNT(*) FROM task_tags WHERE task_id = t.id) as tag_count,
        (SELECT COUNT(*) FROM task_relationships WHERE task_id = t.id OR related_task_id = t.id) as relationship_count,
        (SELECT COUNT(*) FROM task_event_links WHERE task_id = t.id) as event_count
      FROM tasks t
      WHERE t.title = ?
    `).all(group.title);
    
    // Score each task based on richness of data
    const scoredTasks = duplicates.map(task => {
      let score = 0;
      
      // Associations are most valuable
      score += task.topic_count * 100;
      score += task.tag_count * 50;
      score += task.relationship_count * 75;
      score += task.event_count * 60;
      
      // Project association is valuable
      if (task.project_id) score += 80;
      
      // Dates are important
      if (task.do_date) score += 40;
      if (task.completed_at) score += 30;
      
      // Content fields
      if (task.description) score += 20;
      if (task.content) score += 15;
      
      // Notion integration
      if (task.notion_id) score += 25;
      if (task.notion_url) score += 20;
      
      // Recurrence info
      if (task.repeat_interval) score += 35;
      if (task.repeat_next_date) score += 30;
      
      // Stage information
      if (task.stage) score += 10;
      
      // For tasks with equal scores, prefer older ones (lower timestamp)
      // Convert created_at to a small score bonus (earlier = higher)
      const createdTime = new Date(task.created_at || '2024-01-01').getTime();
      const timeDiff = Date.now() - createdTime;
      score += timeDiff / (1000 * 60 * 60 * 24 * 365); // Add up to ~1 point for a year old task
      
      return { ...task, score };
    });
    
    // Sort by score (highest first)
    scoredTasks.sort((a, b) => b.score - a.score);
    
    // Keep the best one
    const keeper = scoredTasks[0];
    keptTasks++;
    
    // Delete the rest
    for (let i = 1; i < scoredTasks.length; i++) {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(scoredTasks[i].id);
      deletedTasks++;
    }
    
    totalDuplicates += duplicates.length - 1;
    
    // Log progress for large duplicate groups
    if (duplicates.length > 100) {
      console.log(`  Processed "${group.title.substring(0, 50)}...": kept 1, deleted ${duplicates.length - 1} (score: ${keeper.score.toFixed(2)})`);
    }
  }
  
  db.exec('COMMIT');
  
  // Final count
  const totalAfter = db.prepare('SELECT COUNT(*) as count FROM tasks').get().count;
  
  console.log('\n=== Deduplication Complete ===');
  console.log(`Tasks before: ${totalBefore}`);
  console.log(`Tasks after: ${totalAfter}`);
  console.log(`Kept tasks: ${keptTasks}`);
  console.log(`Deleted tasks: ${deletedTasks}`);
  console.log(`Total reduction: ${totalBefore - totalAfter} tasks`);
  
} catch (error) {
  db.exec('ROLLBACK');
  console.error('Error during deduplication:', error);
  process.exit(1);
}

db.close();
console.log('\nDatabase deduplication completed successfully!');