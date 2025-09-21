#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase } from '../src/database-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.join(__dirname, '../vault');

// Mapping from database topic names to markdown topic tags
const TOPIC_MAPPING = {
  'Arts, music, and entertainment': 'arts_music_entertainment',
  'Budgeting': 'budgeting',
  'Cats': 'cats',
  'Clubs & Memberships': 'clubs_memberships',
  'Computers/Hardware': 'computers_hardware',
  'Family': 'family',
  'Fitness': 'fitness',
  'Focus': 'focus',
  'Friends/Socializing': 'friends_socializing',
  'Health': 'health',
  'Home/Household': 'home_household',
  'Hosting': 'hosting',
  'Housesitting': 'housesitting',
  'Languages': 'languages',
  'Local Exploration & Adventure': 'local_exploration_adventure',
  'Marketing': 'marketing',
  'Meditation & Mindfulness': 'meditation_mindfulness',
  'Meditation Mindfulness': 'meditation_mindfulness',
  'Mental Health': 'mental_health',
  'Mindset': 'mindset',
  'Nutrition & Diet': 'nutrition_diet',
  'OlderGay.Men': 'ogm',
  'OlderGay.Men Chat Room': 'ogm_chat',
  'OlderGay.Men Events': 'ogm_events',
  'OlderGay.Men Groups': 'ogm_groups',
  'OlderGay.Men Members': 'ogm_members',
  'OlderGay.Men Newsletter': 'ogm_newsletter',
  'OlderGay.Men Patreon': 'ogm_patreon',
  'OlderGay.Men Places': 'ogm_places',
  'OlderGay.Men Staff': 'ogm_staff',
  'OlderGay.Men Stories': 'ogm_stories',
  'OlderGay.Men Sysadmin': 'ogm_sysadmin',
  'Oldergaymen Sysadmin': 'ogm_sysadmin',
  'Oldergaymen Testing': 'ogm_testing',
  'Personal Admin': 'personal_admin',
  'Personal Finance': 'personal_finance',
  'Productivity': 'productivity',
  'Programming': 'programming',
  'Psychology': 'psychology',
  'Relationships': 'relationships',
  'Ron\'s Medical Care': 'health', // Map to general health
  'Solar Energy': 'solar_energy',
  'Team Building': 'team_building',
  'Travel': 'travel',
  'Windows': 'computers_hardware', // Map to general hardware
  'Yard/Pool/Landscaping': 'yard_pool_landscaping'
};

async function findMarkdownFiles(dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'templates') {
      files.push(...await findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeTaskText(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTaskFromLine(line) {
  // Extract task text from markdown line, removing checkboxes, priorities, stage tags, etc.
  const taskMatch = line.match(/^- \[[x ]\]\s*(.+)$/);
  if (!taskMatch) return null;

  let taskText = taskMatch[1];

  // Remove common task metadata
  taskText = taskText.replace(/[🔼⏫🔺⏳📅✅]\s*/g, ''); // Priority and status emojis
  taskText = taskText.replace(/#stage\/[\w-]+/g, ''); // Stage tags
  taskText = taskText.replace(/#topic\/[\w_]+/g, ''); // Existing topic tags
  taskText = taskText.replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, ''); // Due dates
  taskText = taskText.replace(/✅\s*\d{4}-\d{2}-\d{2}/g, ''); // Completion dates
  taskText = taskText.replace(/\s+/g, ' ').trim();

  return taskText;
}

function findSimilarTask(dbTask, markdownTasks) {
  const dbNormalized = normalizeTaskText(dbTask.title);
  const threshold = 0.8; // Similarity threshold

  for (const mdTask of markdownTasks) {
    const mdNormalized = normalizeTaskText(mdTask.text);

    // Only allow substring matches if both strings are substantial (>= 8 chars)
    // and the shorter one is at least 60% of the longer one's length
    const minLength = Math.min(dbNormalized.length, mdNormalized.length);
    const maxLength = Math.max(dbNormalized.length, mdNormalized.length);

    if (minLength >= 8 && (minLength / maxLength) >= 0.6) {
      if (dbNormalized.includes(mdNormalized) || mdNormalized.includes(dbNormalized)) {
        return { task: mdTask, confidence: 'high', reason: 'substantial substring match' };
      }
    }

    // Check for significant word overlap (word-based matching is safer)
    const dbWords = new Set(dbNormalized.split(' ').filter(w => w.length > 2));
    const mdWords = new Set(mdNormalized.split(' ').filter(w => w.length > 2));

    const intersection = new Set([...dbWords].filter(w => mdWords.has(w)));
    const union = new Set([...dbWords, ...mdWords]);

    if (union.size > 0) {
      const similarity = intersection.size / union.size;
      if (similarity >= threshold) {
        return { task: mdTask, confidence: 'medium', reason: `${Math.round(similarity * 100)}% word overlap` };
      }
    }
  }

  return null;
}

function addTopicsToTask(taskLine, newTopics) {
  // Add topic tags to the end of a task line
  const existingTopics = (taskLine.match(/#topic\/[\w_]+/g) || []);
  const existingTopicSet = new Set(existingTopics);

  const topicsToAdd = newTopics.filter(topic => !existingTopicSet.has(`#topic/${topic}`));

  if (topicsToAdd.length === 0) {
    return taskLine; // No new topics to add
  }

  const newTopicTags = topicsToAdd.map(topic => `#topic/${topic}`);
  return `${taskLine} ${newTopicTags.join(' ')}`;
}

async function processFile(filePath, dbTasks, dryRun = true) {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const changes = [];

  // Extract all tasks from the file
  const markdownTasks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only process undone tasks ([ ], not [x])
    if (/^- \[ \]/.test(line)) {
      const taskText = extractTaskFromLine(line);
      if (taskText) {
        markdownTasks.push({
          lineNumber: i,
          text: taskText,
          fullLine: line
        });
      }
    }
  }

  // Find matches for each markdown task
  for (const mdTask of markdownTasks) {
    let bestMatch = null;
    let bestScore = 0;

    for (const dbTask of dbTasks) {
      const match = findSimilarTask(dbTask, [mdTask]);
      if (match && match.confidence === 'high') {
        bestMatch = { dbTask, ...match };
        break; // High confidence match, stop looking
      } else if (match && match.confidence === 'medium') {
        // Keep looking for better matches
        const score = match.reason.includes('%') ? parseInt(match.reason) : 50;
        if (score > bestScore) {
          bestMatch = { dbTask, ...match };
          bestScore = score;
        }
      }
    }

    if (bestMatch && bestMatch.dbTask.topics && bestMatch.dbTask.topics.length > 0) {
      // Map database topics to markdown format
      const markdownTopics = bestMatch.dbTask.topics
        .map(topic => TOPIC_MAPPING[topic])
        .filter(Boolean);

      if (markdownTopics.length > 0) {
        const newLine = addTopicsToTask(mdTask.fullLine, markdownTopics);
        if (newLine !== mdTask.fullLine) {
          changes.push({
            lineNumber: mdTask.lineNumber + 1,
            original: mdTask.fullLine,
            updated: newLine,
            dbTask: bestMatch.dbTask.title,
            confidence: bestMatch.confidence,
            reason: bestMatch.reason,
            addedTopics: markdownTopics
          });
        }
      }
    }
  }

  return changes;
}

async function main() {
  const dryRun = !process.argv.includes('--execute');

  console.log(dryRun ? '🔍 DRY RUN - Analyzing topic mappings:' : '🔧 EXECUTING - Mapping database topics to markdown files:');
  console.log('');

  try {
    // Get database connection
    const db = getDatabase();

    // Fetch all tasks with their topics from database
    console.log('📊 Loading tasks from database...');
    const dbTasks = db.all(`
      SELECT
        t.id,
        t.title,
        GROUP_CONCAT(tp.name, '||') as topic_names
      FROM tasks t
      LEFT JOIN task_topics tt ON t.id = tt.task_id
      LEFT JOIN topics tp ON tt.topic_id = tp.id
      WHERE t.title IS NOT NULL
      GROUP BY t.id
      ORDER BY t.id
    `).map(row => ({
      ...row,
      topics: row.topic_names ? row.topic_names.split('||') : []
    }));

    console.log(`Found ${dbTasks.length} tasks in database`);
    console.log(`Tasks with topics: ${dbTasks.filter(t => t.topics.length > 0).length}`);
    console.log('');

    // Find all markdown files
    const files = await findMarkdownFiles(vaultDir);
    console.log(`📁 Scanning ${files.length} markdown files...`);
    console.log('');

    let totalChanges = 0;
    let filesWithChanges = 0;

    for (const filePath of files) {
      const changes = await processFile(filePath, dbTasks, dryRun);

      if (changes.length > 0) {
        const relativePath = path.relative(vaultDir, filePath);
        console.log(`📄 ${relativePath} (${changes.length} matches)`);

        for (const change of changes) {
          console.log(`  Line ${change.lineNumber}: ${change.confidence} confidence (${change.reason})`);
          console.log(`    DB Task: "${change.dbTask}"`);
          console.log(`    Added topics: ${change.addedTopics.map(t => `#topic/${t}`).join(', ')}`);
          console.log(`    - ${change.original}`);
          console.log(`    + ${change.updated}`);
          console.log('');
        }

        totalChanges += changes.length;
        filesWithChanges++;

        if (!dryRun) {
          // Apply changes
          const content = await fs.readFile(filePath, 'utf-8');
          const lines = content.split('\n');

          // Apply changes in reverse order to maintain line numbers
          const sortedChanges = changes.sort((a, b) => b.lineNumber - a.lineNumber);
          for (const change of sortedChanges) {
            lines[change.lineNumber - 1] = change.updated;
          }

          await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
        }
      }
    }

    console.log(`📊 Summary:`);
    console.log(`  - Total matches found: ${totalChanges}`);
    console.log(`  - Files with changes: ${filesWithChanges}`);
    console.log(`  - Mode: ${dryRun ? 'DRY RUN' : 'EXECUTED'}`);

    if (dryRun && totalChanges > 0) {
      console.log('');
      console.log('To apply these changes, run:');
      console.log('  node bin/map-database-topics-improved.js --execute');
    }

    // Close database connection to allow process to exit
    await db.close();

  } catch (error) {
    console.error('❌ Error:', error.message);
    try {
      const db = getDatabase();
      await db.close();
    } catch {}
    process.exit(1);
  }
}

main();