import Database from 'better-sqlite3';

const db = new Database('.data/today.db');

// Check for empty tasks
const emptyCount = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE title = '' OR title IS NULL").get();
console.log(`Empty tasks: ${emptyCount.count}`);

// Check for non-empty tasks
const nonEmptyCount = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE title != '' AND title IS NOT NULL").get();
console.log(`Non-empty tasks: ${nonEmptyCount.count}`);

// Find duplicate non-empty tasks
const duplicates = db.prepare(`
  SELECT title, COUNT(*) as count 
  FROM tasks 
  WHERE title != '' AND title IS NOT NULL
  GROUP BY title 
  HAVING COUNT(*) > 1 
  ORDER BY count DESC 
  LIMIT 10
`).all();

console.log('\nTop duplicate tasks:');
duplicates.forEach(d => {
  console.log(`  ${d.count}x: ${d.title.substring(0, 50)}...`);
});

db.close();