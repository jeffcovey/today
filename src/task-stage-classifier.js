#!/usr/bin/env node

import { TaskManager } from './task-manager.js';
import { execSync } from 'child_process';
import fetch from 'node-fetch';

export class TaskStageClassifier {
  constructor() {
    this.tm = new TaskManager();
    this.ollamaAvailable = false;
    this.ollamaModel = null;
    this.checkOllama();
  }

  checkOllama() {
    try {
      // Check if Ollama is running
      const response = execSync('curl -s http://localhost:11434/api/tags', { encoding: 'utf8' });
      const data = JSON.parse(response);
      if (data.models && data.models.length > 0) {
        this.ollamaAvailable = true;
        // Prefer smaller, faster models for this task
        const preferredModels = ['llama3.2', 'llama3.1', 'mistral', 'phi3', 'gemma2'];
        for (const preferred of preferredModels) {
          const model = data.models.find(m => m.name.includes(preferred));
          if (model) {
            this.ollamaModel = model.name;
            break;
          }
        }
        // Fall back to first available model
        if (!this.ollamaModel && data.models.length > 0) {
          this.ollamaModel = data.models[0].name;
        }
      }
    } catch (err) {
      // Ollama not available
      this.ollamaAvailable = false;
    }
  }

  async classifyWithOllama(task, projectName) {
    const prompt = `You are a task classifier. Classify this task into exactly one of these stages based on its nature:
- "Front Stage": Tasks involving interaction with other people (meetings, calls, emails, customer support, presentations)
- "Back Stage": Maintenance and behind-the-scenes work (organizing, cleaning, fixing bugs, paying bills, administrative tasks)
- "Off Stage": Personal time and self-care (reading, exercise, hobbies, relaxation, learning)

Task: "${task.title}"
${projectName ? `Project: ${projectName}` : ''}
${task.description ? `Description: ${task.description}` : ''}

Respond with ONLY one of: "Front Stage", "Back Stage", or "Off Stage"`;

    try {
      const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.1,  // Low temperature for consistency
            num_predict: 20    // Limit response length
          }
        })
      });

      const data = await response.json();
      const stage = this.extractStage(data.response);
      return stage;
    } catch (err) {
      console.error(`Failed to classify task ${task.id}:`, err.message);
      return null;
    }
  }

  async classifyWithClaude(tasks) {
    // Process in smaller batches to avoid timeouts - only one batch per invocation
    const BATCH_SIZE = 40; // Process 40 tasks at a time
    const allClassifications = [];
    
    // Only process the first batch per invocation
    const batch = tasks.slice(0, Math.min(BATCH_SIZE, tasks.length));
    
    if (batch.length === 0) {
      console.log('  No tasks to classify');
      return [];
    }
      
    // Build a batch prompt for Claude
    const taskList = batch.map(t => {
      const project = t.project_id ? 
        this.tm.db.prepare('SELECT name FROM projects WHERE id = ?').get(t.project_id) : null;
      return {
        id: t.id,
        title: t.title,
        project: project?.name || null,
        description: t.description
      };
    });

    const prompt = `Classify each task into exactly one stage based on its nature:
- "Front Stage": Tasks involving interaction with other people (meetings, calls, emails, customer support, presentations, social activities)
- "Back Stage": Maintenance and behind-the-scenes work (organizing, cleaning, fixing bugs, paying bills, admin, planning, setup)
- "Off Stage": Personal time and self-care (reading, exercise, hobbies, relaxation, learning, health)

For each task, respond with a JSON object like: {"id": "task_id", "stage": "Front Stage"}

Tasks to classify:
${JSON.stringify(taskList, null, 2)}

Respond with a JSON array containing the classification for each task.`;

    try {
      console.log(`  Processing batch 1/1 (${batch.length} tasks)...`);
      
      // Use claude CLI with --print flag for non-interactive mode
      const result = execSync(`claude --print '${prompt.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        timeout: 60000 // 60 second timeout per batch
      });

      // Extract JSON from Claude's response
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const classifications = JSON.parse(jsonMatch[0]);
        allClassifications.push(...classifications);
        console.log(`  Classified ${classifications.length} tasks in this batch`);
      } else {
        console.error(`Could not parse Claude response for batch`);
      }
    } catch (err) {
      console.error(`Failed to classify batch with Claude:`, err.message);
    }
    
    return allClassifications;
  }

  extractStage(text) {
    // Extract stage from LLM response
    if (text.includes('Front Stage')) return 'Front Stage';
    if (text.includes('Back Stage')) return 'Back Stage';
    if (text.includes('Off Stage')) return 'Off Stage';
    
    // Try to find it without exact case
    const lower = text.toLowerCase();
    if (lower.includes('front')) return 'Front Stage';
    if (lower.includes('back')) return 'Back Stage';
    if (lower.includes('off')) return 'Off Stage';
    
    return null;
  }

  async classifyTasks(onlyUnclassified = true) {
    // Get tasks that need classification
    const tasks = onlyUnclassified ?
      this.tm.db.prepare(`
        SELECT * FROM tasks 
        WHERE stage IS NULL 
          AND status != '✅ Done'
        ORDER BY do_date ASC, status ASC
      `).all() :
      this.tm.db.prepare(`
        SELECT * FROM tasks 
        WHERE status != '✅ Done'
        ORDER BY do_date ASC, status ASC
      `).all();

    if (tasks.length === 0) {
      console.log('No tasks need stage classification');
      return { classified: 0, failed: 0 };
    }

    console.log(`Found ${tasks.length} tasks to classify`);
    console.log(`Using ${this.ollamaAvailable ? `Ollama (${this.ollamaModel})` : 'Claude'} for classification`);

    let classified = 0;
    let failed = 0;

    if (this.ollamaAvailable) {
      // Process with Ollama one by one
      for (const task of tasks) {
        const project = task.project_id ? 
          this.tm.db.prepare('SELECT name FROM projects WHERE id = ?').get(task.project_id) : null;
        
        process.stdout.write(`Classifying: ${task.title.substring(0, 50)}...`);
        const stage = await this.classifyWithOllama(task, project?.name);
        
        if (stage) {
          this.tm.updateTask(task.id, { stage });
          console.log(` → ${stage}`);
          classified++;
        } else {
          console.log(' → Failed');
          failed++;
        }
      }
    } else {
      // Process with Claude in batch
      console.log('Sending batch to Claude for classification...');
      const classifications = await this.classifyWithClaude(tasks);
      
      for (const classification of classifications) {
        const task = tasks.find(t => t.id === classification.id);
        if (task && classification.stage) {
          this.tm.updateTask(task.id, { stage: classification.stage });
          console.log(`  ${task.title.substring(0, 50)}... → ${classification.stage}`);
          classified++;
        } else {
          failed++;
        }
      }
    }

    // Show summary by stage
    const stageCounts = this.tm.db.prepare(`
      SELECT stage, COUNT(*) as count 
      FROM tasks 
      WHERE stage IS NOT NULL 
        AND status != '✅ Done'
      GROUP BY stage
    `).all();

    console.log('\nStage distribution:');
    for (const { stage, count } of stageCounts) {
      console.log(`  ${stage}: ${count} tasks`);
    }

    return { classified, failed };
  }

  close() {
    this.tm.close();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const classifier = new TaskStageClassifier();
  
  // Parse arguments
  const args = process.argv.slice(2);
  const forceAll = args.includes('--all');
  
  classifier.classifyTasks(!forceAll).then(result => {
    console.log(`\n✓ Classified ${result.classified} tasks`);
    if (result.failed > 0) {
      console.log(`✗ Failed to classify ${result.failed} tasks`);
    }
    classifier.close();
  }).catch(err => {
    console.error('Error:', err);
    classifier.close();
    process.exit(1);
  });
}