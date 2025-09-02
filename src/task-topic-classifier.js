#!/usr/bin/env node

import { getDatabase } from './database-service.js';
import { execSync } from 'child_process';

export class TaskTopicClassifier {
  constructor(dbPath = '.data/today.db') {
    this.db = getDatabase(dbPath);
    this.availableTopics = [];
    this.claudeAvailable = this.checkClaude();
  }

  checkClaude() {
    try {
      // Check if claude CLI is available
      execSync('which claude', { encoding: 'utf8' });
      return true;
    } catch (err) {
      console.warn('⚠️  Claude CLI not available - topic classification disabled');
      console.warn('   Install claude CLI to enable AI topic assignment');
      return false;
    }
  }

  loadAvailableTopics() {
    // Get all available topics from database
    const topics = this.db.prepare('SELECT id, name FROM topics ORDER BY name').all();
    this.availableTopics = topics;
    return topics;
  }

  async classifyWithClaude(tasks, verbose = false) {
    // Process in smaller batches to avoid timeouts
    const BATCH_SIZE = 10;
    let totalClassified = 0;
    let totalFailed = 0;
    
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, Math.min(i + BATCH_SIZE, tasks.length));
      
      // Build batch prompt
      const taskList = batch.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description || ''
      }));

      const topicList = this.availableTopics.map(t => t.name).join(', ');
      
      const prompt = `Analyze these tasks and suggest 1-3 relevant topics for each from the available list.

Available topics:
${topicList}

For each task, suggest the most relevant topics based on:
- Keywords in the title that match topic areas
- The nature of the work (technical, personal, organizational)
- Related areas that might be involved

Respond with a JSON array where each item has:
{"id": "task_id", "topics": ["Topic1", "Topic2"]}

If no topics apply to a task, use an empty array for topics.

Tasks to classify:
${JSON.stringify(taskList, null, 2)}`;

      try {
        console.log(`  Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(tasks.length/BATCH_SIZE)} (${batch.length} tasks)...`);
        
        // Use claude CLI with --print flag
        const result = execSync(`claude --print '${prompt.replace(/'/g, "'\\''")}'`, {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024 * 10, // 10MB buffer
          timeout: 300000 // 5 minute timeout
        });

        // Extract JSON from response
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const classifications = JSON.parse(jsonMatch[0]);
          
          // Map topic names to IDs
          for (const classification of classifications) {
            const task = batch.find(t => t.id === classification.id);
            if (task && classification.topics) {
              const matchedTopics = [];
              for (const topicName of classification.topics) {
                const topic = this.availableTopics.find(t => 
                  t.name.toLowerCase() === topicName.toLowerCase()
                );
                if (topic) {
                  matchedTopics.push(topic.id);
                }
              }
              if (matchedTopics.length > 0) {
                // Save immediately to database
                try {
                  await this.assignTopicsToTask(task.id, matchedTopics);
                  totalClassified++;
                  
                  if (verbose) {
                    const topicNames = matchedTopics.map(id => 
                      this.availableTopics.find(t => t.id === id)?.name
                    ).filter(Boolean);
                    console.log(`    ${task.title.substring(0, 50)}... → ${topicNames.join(', ')}`);
                  }
                } catch (error) {
                  console.error(`    Failed to assign topics to task ${task.id}:`, error.message);
                  totalFailed++;
                }
              }
            }
          }
        }
      } catch (error) {
        console.error(`  Failed to classify batch:`, error.message);
        totalFailed += batch.length;
      }
      
      // Small delay between batches
      if (i + BATCH_SIZE < tasks.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return { classified: totalClassified, failed: totalFailed };
  }

  async assignTopicsToTask(taskId, topicIds) {
    // First remove any existing topic assignments
    this.db.prepare('DELETE FROM task_topics WHERE task_id = ?').run(taskId);
    
    // Then add new topic assignments
    const stmt = this.db.prepare('INSERT INTO task_topics (task_id, topic_id) VALUES (?, ?)');
    for (const topicId of topicIds) {
      stmt.run(taskId, topicId);
    }
  }

  async classifyTasks(onlyUnclassified = true, verbose = false) {
    // Check if Claude CLI is available
    if (!this.claudeAvailable) {
      return { classified: 0, failed: 0 };
    }
    
    // Load available topics
    this.loadAvailableTopics();
    
    if (this.availableTopics.length === 0) {
      console.error('No topics found in database. Please create topics first.');
      return { classified: 0, failed: 0 };
    }

    // Get tasks to classify
    let query;
    if (onlyUnclassified) {
      // Get tasks that have no topics assigned
      // Sort tasks with do_date first
      query = `
        SELECT t.id, t.title, t.description 
        FROM tasks t
        WHERE t.status != '✅ Done'
          AND t.id NOT IN (SELECT DISTINCT task_id FROM task_topics)
        ORDER BY 
          CASE WHEN t.do_date IS NOT NULL THEN 0 ELSE 1 END,
          t.do_date ASC,
          t.created_at DESC
      `;
    } else {
      // Get all active tasks
      // Sort tasks with do_date first
      query = `
        SELECT id, title, description 
        FROM tasks 
        WHERE status != '✅ Done'
        ORDER BY 
          CASE WHEN do_date IS NOT NULL THEN 0 ELSE 1 END,
          do_date ASC,
          created_at DESC
      `;
    }

    const tasks = this.db.prepare(query).all();
    
    if (tasks.length === 0) {
      if (verbose) {
        console.log('No tasks need topic classification');
      }
      return { classified: 0, failed: 0 };
    }

    if (verbose) {
      console.log(`Found ${tasks.length} tasks to classify with topics`);
      console.log(`Available topics: ${this.availableTopics.map(t => t.name).join(', ')}`);
      console.log('Using Claude CLI for classification...');
    }

    // Use Claude to classify all tasks in batches
    const result = await this.classifyWithClaude(tasks, verbose);
    
    return result;
  }

  async close() {
    // Close the database connection
    if (this.db && this.db.close) {
      await this.db.close();
    }
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const classifier = new TaskTopicClassifier();
  
  // Parse arguments
  const args = process.argv.slice(2);
  const forceAll = args.includes('--all');
  const verbose = args.includes('-v') || args.includes('--verbose');
  
  classifier.classifyTasks(!forceAll, verbose)
    .then(async result => {
      console.log(`\n✓ Assigned topics to ${result.classified} tasks`);
      if (result.failed > 0) {
        console.log(`✗ Failed to classify ${result.failed} tasks`);
      }
      await classifier.close();
      // Force exit to ensure all timers are cleared
      setTimeout(() => process.exit(0), 100);
    })
    .catch(async error => {
      console.error('Error:', error.message);
      await classifier.close();
      // Force exit to ensure all timers are cleared
      setTimeout(() => process.exit(1), 100);
    });
}