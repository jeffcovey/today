#!/usr/bin/env node

import { getDatabase } from './database-service.js';
import { execSync } from 'child_process';

export class TaskStatusClassifier {
  constructor(dbPath = '.data/today.db') {
    this.db = getDatabase(dbPath);
    this.claudeAvailable = this.checkClaude();
  }

  checkClaude() {
    try {
      // Check if claude CLI is available
      execSync('which claude', { encoding: 'utf8' });
      return true;
    } catch (err) {
      console.warn('⚠️  Claude CLI not available - status classification disabled');
      console.warn('   Install claude CLI to enable AI status prioritization');
      return false;
    }
  }

  async classifyWithClaude(tasks, verbose = false) {
    // Process in batches for efficiency
    const BATCH_SIZE = 20;
    let totalClassified = 0;
    let totalFailed = 0;
    const updateStmt = this.db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, Math.min(i + BATCH_SIZE, tasks.length));
      
      // Build batch prompt
      const taskList = batch.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description || '',
        stage: t.stage || 'Unknown'
      }));

      const prompt = `Analyze these tasks currently in "To File" status and assign each to an appropriate priority status.

You MUST choose from EXACTLY these 5 statuses (including the emoji and spacing):
- "1️⃣  1st Priority" - Urgent and important tasks that need immediate attention (health, pets, finances, critical fixes)
- "2️⃣  2nd Priority" - Important but less urgent (maintenance, planning, optimization)
- "3️⃣  3rd Priority" - Nice to have, routine tasks (entertainment, grooming, reference items)
- "🤔 Waiting" - Tasks blocked waiting for external input or confirmation
- "⏸️  Paused" - Tasks intentionally deferred or for future activation (like packing lists)

IMPORTANT: Do NOT use "✅ Done" or "🗂️  To File" or any other status. Every task MUST be assigned to one of the 5 statuses above.

Consider:
- Financial obligations and deadlines → 1st Priority
- Pet care and health items → 1st Priority  
- Security and critical system fixes → 1st Priority
- Home maintenance and business improvements → 2nd Priority
- Travel planning and organization → 2nd Priority
- Entertainment and personal grooming → 3rd Priority
- Checklists and reference items → Paused
- Items needing confirmation → Waiting

Respond with a JSON array where each item has:
{"id": "task_id", "status": "exact_status_string"}

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
          try {
            const classifications = JSON.parse(jsonMatch[0]);
          
          // Apply classifications immediately
          for (const classification of classifications) {
            try {
              // Validate the status is one of our allowed values
              const allowedStatuses = [
                '1️⃣  1st Priority',
                '2️⃣  2nd Priority', 
                '3️⃣  3rd Priority',
                '🤔 Waiting',
                '⏸️  Paused'
              ];
              
              if (!allowedStatuses.includes(classification.status)) {
                console.error(`  Invalid status "${classification.status}" for task ${classification.id}`);
                totalFailed++;
                continue;
              }

              // Update the task status
              updateStmt.run(classification.status, classification.id);
              totalClassified++;
              
              if (verbose) {
                const task = batch.find(t => t.id === classification.id);
                if (task) {
                  console.log(`    ${task.title.substring(0, 50)}... → ${classification.status}`);
                }
              }
            } catch (error) {
              console.error(`  Failed to update status for task ${classification.id}:`, error.message);
              totalFailed++;
            }
          }
          } catch (parseError) {
            console.error(`  Failed to parse JSON:`, parseError.message);
            console.error(`  JSON string was:`, jsonMatch[0].substring(0, 200));
            totalFailed += batch.length;
          }
        } else {
          console.error(`  No JSON array found in Claude response`);
          console.error(`  Response preview:`, result.substring(0, 200));
          totalFailed += batch.length;
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

  async classifyTasks(verbose = false) {
    // Check if Claude CLI is available
    if (!this.claudeAvailable) {
      return { classified: 0, failed: 0 };
    }

    // Get tasks that are in "To File" status
    // Sort tasks with do_date first
    const query = `
      SELECT id, title, description, stage 
      FROM tasks 
      WHERE status = '🗂️  To File'
      ORDER BY 
        CASE WHEN do_date IS NOT NULL THEN 0 ELSE 1 END,
        do_date ASC,
        created_at DESC
    `;

    const tasks = this.db.prepare(query).all();
    
    if (tasks.length === 0) {
      if (verbose) {
        console.log('No tasks in "To File" status need prioritization');
      }
      return { classified: 0, failed: 0 };
    }

    if (verbose) {
      console.log(`Found ${tasks.length} tasks in "To File" status to prioritize`);
      console.log('Using Claude CLI for classification...');
    }

    // Use Claude to classify all tasks in batches
    const result = await this.classifyWithClaude(tasks, verbose);

    // Show summary by status
    if (verbose && result.classified > 0) {
      const statusCounts = this.db.prepare(`
        SELECT status, COUNT(*) as count 
        FROM tasks 
        WHERE status != '✅ Done'
        GROUP BY status
        ORDER BY 
          CASE status
            WHEN '1️⃣  1st Priority' THEN 1
            WHEN '2️⃣  2nd Priority' THEN 2
            WHEN '3️⃣  3rd Priority' THEN 3
            WHEN '🤔 Waiting' THEN 4
            WHEN '⏸️  Paused' THEN 5
            WHEN '🗂️  To File' THEN 6
            ELSE 7
          END
      `).all();

      console.log('\nStatus distribution:');
      for (const { status, count } of statusCounts) {
        console.log(`  ${status}: ${count} tasks`);
      }
    }

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
  const classifier = new TaskStatusClassifier();
  
  // Parse arguments
  const args = process.argv.slice(2);
  const verbose = args.includes('-v') || args.includes('--verbose');
  
  classifier.classifyTasks(verbose)
    .then(async result => {
      console.log(`\n✓ Prioritized ${result.classified} tasks from "To File" status`);
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