#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { watch } from 'chokidar';
import { execSync } from 'child_process';

class TaskCache {
  constructor(vaultPath = './vault/') {
    this.vaultPath = vaultPath;
    this.cache = new Map(); // filename -> tasks array
    this.watcher = null;
    this.ready = false;
  }

  async initialize() {
    console.log('[TaskCache] Initializing task cache...');

    // Initial scan of all markdown files
    await this.scanAllFiles();

    // Set up file watcher
    this.setupWatcher();

    this.ready = true;
    console.log(`[TaskCache] Ready with ${this.cache.size} files cached`);
  }

  async scanAllFiles() {
    const startTime = Date.now();

    // Use find to get all .md files, excluding system directories
    const findCmd = `find ${this.vaultPath} -name "*.md" -type f ! -path "*/.*" 2>/dev/null || true`;

    try {
      const output = execSync(findCmd, { encoding: 'utf8' });
      const files = output.split('\n').filter(Boolean);

      console.log(`[TaskCache] Found ${files.length} markdown files to scan`);

      // Process files in parallel batches
      const batchSize = 50;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.all(batch.map(file => this.scanFile(file)));
      }

      const elapsed = Date.now() - startTime;
      console.log(`[TaskCache] Initial scan completed in ${elapsed}ms`);
    } catch (error) {
      console.error('[TaskCache] Error scanning files:', error.message);
    }
  }

  async scanFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const tasks = this.extractTasksFromContent(content, filePath);

      if (tasks.length > 0) {
        this.cache.set(filePath, tasks);
      } else {
        this.cache.delete(filePath); // Remove if no tasks
      }
    } catch (error) {
      console.error(`[TaskCache] Error scanning ${filePath}:`, error.message);
    }
  }

  extractTasksFromContent(content, filePath) {
    const tasks = [];
    const lines = content.split('\n');
    const taskRegex = /^- \[[ x]\] (.+)$/;

    for (const line of lines) {
      const match = line.match(taskRegex);
      if (match) {
        const taskContent = match[1];
        const isDone = line.includes('[x]');

        // Parse dates and properties
        let scheduledDate = null;
        let dueDate = null;
        let doneDate = null;
        let priority = 0;

        const scheduledMatch = taskContent.match(/⏳ (\d{4}-\d{2}-\d{2})/);
        if (scheduledMatch) scheduledDate = new Date(scheduledMatch[1] + 'T00:00:00');

        const dueMatch = taskContent.match(/📅 (\d{4}-\d{2}-\d{2})/);
        if (dueMatch) dueDate = new Date(dueMatch[1] + 'T00:00:00');

        const doneMatch = taskContent.match(/✅ (\d{4}-\d{2}-\d{2})/);
        if (doneMatch) doneDate = new Date(doneMatch[1] + 'T00:00:00');

        if (taskContent.includes('🔺')) priority = 3;
        else if (taskContent.includes('🔼')) priority = 2;
        else if (taskContent.includes('⏫')) priority = 1;

        // Clean task text for display
        let cleanText = taskContent
          .replace(/[⏳📅✅] \d{4}-\d{2}-\d{2}/g, '')
          .replace(/🔺|🔼|⏫/g, '')
          .replace(/🔁 .+/g, '')
          .replace(/<!--.*?-->/g, '')
          .trim();

        tasks.push({
          filePath: path.relative(this.vaultPath, filePath),
          text: cleanText,
          originalText: taskContent,
          isDone,
          scheduledDate,
          dueDate,
          doneDate,
          priority,
          happens: scheduledDate || dueDate
        });
      }
    }

    return tasks;
  }

  setupWatcher() {
    this.watcher = watch(`${this.vaultPath}/**/*.md`, {
      ignored: [
        '**/node_modules/**',
        '**/@inbox/**',
        '**/.git/**',
        '**/.obsidian/**',
        '**/.trash/**'
      ],
      persistent: true,
      ignoreInitial: true
    });

    this.watcher.on('add', path => {
      console.log(`[TaskCache] File added: ${path}`);
      this.scanFile(path);
    });

    this.watcher.on('change', path => {
      console.log(`[TaskCache] File changed: ${path}`);
      this.scanFile(path);
    });

    this.watcher.on('unlink', path => {
      console.log(`[TaskCache] File removed: ${path}`);
      this.cache.delete(path);
    });
  }

  getAllTasks() {
    const allTasks = [];
    for (const tasks of this.cache.values()) {
      allTasks.push(...tasks);
    }
    return allTasks;
  }

  async close() {
    if (this.watcher) {
      await this.watcher.close();
    }
  }
}

export default TaskCache;