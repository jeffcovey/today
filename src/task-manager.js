import crypto from 'crypto';
import fs from 'fs/promises';
import { getDatabaseSync } from './database-sync.js';

export class TaskManager {
  constructor(dbPath = '.data/today.db', options = {}) {
    // Use DatabaseSync wrapper for automatic Turso sync
    // Pass readOnly option to skip Turso initialization for read-only operations
    this.db = getDatabaseSync(dbPath, { readOnly: options.readOnly || false });
    this.initDatabase();
  }

  initDatabase() {
    // Disable foreign keys to avoid issues during sync
    this.db.exec('PRAGMA foreign_keys = OFF');
    
    // Create tasks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        title TEXT NOT NULL,
        description TEXT,
        content TEXT,
        do_date DATE,
        status TEXT DEFAULT '🎭 Stage',
        stage TEXT CHECK(stage IS NULL OR stage IN ('Front Stage', 'Back Stage', 'Off Stage')),
        project_id TEXT,
        repeat_interval INTEGER,
        repeat_next_date DATE,
        notion_id TEXT UNIQUE,
        notion_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `);

    // Create tags table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT UNIQUE NOT NULL,
        color TEXT
      )
    `);

    // Create task_tags junction table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_tags (
        task_id TEXT,
        tag_id TEXT,
        PRIMARY KEY (task_id, tag_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      )
    `);

    // Create projects table with more metadata
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active',
        start_date DATE,
        end_date DATE,
        budget REAL,
        file_path TEXT UNIQUE,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create markdown_sync table to track file-task relationships
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS markdown_sync (
        file_path TEXT NOT NULL,
        task_id TEXT NOT NULL,
        line_number INTEGER,
        last_synced DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (file_path, task_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);

    // Create task completion history for repeating tasks
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_do_date ON tasks(do_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(stage);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_task_tags_task ON task_tags(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);
      CREATE INDEX IF NOT EXISTS idx_completions_task ON task_completions(task_id);
      CREATE INDEX IF NOT EXISTS idx_completions_date ON task_completions(completed_at);
    `);

    // Add trigger to update updated_at
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_task_timestamp 
      AFTER UPDATE ON tasks
      BEGIN
        UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `);
  }

  // Generate a unique ID for a task
  generateId() {
    return crypto.randomBytes(16).toString('hex').toLowerCase();
  }

  // Create a new task
  createTask(data) {
    const id = data.id || this.generateId();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, content, do_date, status, stage, project_id, repeat_interval, notion_id, notion_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      id,
      data.title,
      data.description || null,
      data.content || null,
      data.do_date || null,
      data.status || '🎭 Stage',
      data.stage || null,
      data.project_id || null,
      data.repeat_interval || null,
      data.notion_id || null,
      data.notion_url || null
    );

    // Add tags if provided
    if (data.tags && data.tags.length > 0) {
      this.setTaskTags(id, data.tags);
    }

    return id;
  }

  // Update a task
  updateTask(id, data) {
    const fields = [];
    const values = [];

    if (data.title !== undefined) {
      fields.push('title = ?');
      values.push(data.title);
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      values.push(data.description);
    }
    if (data.do_date !== undefined) {
      fields.push('do_date = ?');
      values.push(data.do_date);
    }
    if (data.status !== undefined) {
      fields.push('status = ?');
      values.push(data.status);
      
      // Set completed_at when marking as done and record in history
      if (data.status === '✅ Done') {
        fields.push('completed_at = CURRENT_TIMESTAMP');
        // Record completion in history for repeating tasks
        const task = this.getTask(id);
        if (task && task.repeat_interval) {
          this.db.prepare('INSERT INTO task_completions (task_id) VALUES (?)').run(id);
        }
      } else if (data.status !== '✅ Done') {
        fields.push('completed_at = NULL');
      }
    }
    if (data.stage !== undefined) {
      fields.push('stage = ?');
      values.push(data.stage);
    }
    if (data.project_id !== undefined) {
      fields.push('project_id = ?');
      values.push(data.project_id);
    }
    if (data.repeat_interval !== undefined) {
      fields.push('repeat_interval = ?');
      values.push(data.repeat_interval);
    }

    if (fields.length > 0) {
      values.push(id);
      const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
    }

    // Update tags if provided
    if (data.tags !== undefined) {
      this.setTaskTags(id, data.tags);
    }
  }

  // Get a task by ID
  getTask(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (task) {
      task.tags = this.getTaskTags(id);
      // Get last completion if it's a repeating task
      if (task.repeat_interval) {
        const lastCompletion = this.db.prepare(`
          SELECT MAX(completed_at) as last_completed 
          FROM task_completions 
          WHERE task_id = ?
        `).get(id);
        task.last_completed = lastCompletion?.last_completed;
      }
    }
    return task;
  }

  // Get tasks for today
  getTodayTasks() {
    const today = new Date().toISOString().split('T')[0];
    const tasks = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE (do_date = ? OR do_date < ?) 
        AND status != '✅ Done'
      ORDER BY do_date ASC, status ASC
    `).all(today, today);

    return tasks.map(task => ({
      ...task,
      tags: this.getTaskTags(task.id)
    }));
  }

  // Get all active tasks
  getActiveTasks() {
    const tasks = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE status != '✅ Done'
      ORDER BY do_date ASC, status ASC
    `).all();

    return tasks.map(task => ({
      ...task,
      tags: this.getTaskTags(task.id)
    }));
  }

  // Get tasks by project
  getProjectTasks(projectId) {
    // Handle partial project ID (first 8 chars)
    let actualProjectId = projectId;
    if (projectId.length < 32) {
      const project = this.db.prepare(`
        SELECT id FROM projects 
        WHERE id LIKE ?
      `).get(projectId + '%');
      if (project) {
        actualProjectId = project.id;
      }
    }
    
    const tasks = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE project_id = ?
      ORDER BY stage ASC, status ASC
    `).all(actualProjectId);

    return tasks.map(task => ({
      ...task,
      tags: this.getTaskTags(task.id)
    }));
  }

  // Tag management
  createTag(name, color = null) {
    const id = this.generateId();
    const stmt = this.db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)');
    stmt.run(id, name, color);
    return id;
  }

  getOrCreateTag(name) {
    let tag = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
    if (!tag) {
      const id = this.createTag(name);
      return id;
    }
    return tag.id;
  }

  setTaskTags(taskId, tagNames) {
    // Remove existing tags
    this.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);

    // Add new tags
    const stmt = this.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)');
    for (const tagName of tagNames) {
      const tagId = this.getOrCreateTag(tagName);
      stmt.run(taskId, tagId);
    }
  }

  getTaskTags(taskId) {
    return this.db.prepare(`
      SELECT t.name 
      FROM tags t 
      JOIN task_tags tt ON t.id = tt.tag_id 
      WHERE tt.task_id = ?
    `).all(taskId).map(row => row.name);
  }

  // Project management
  createProject(data) {
    const id = data.id || this.generateId();
    const stmt = this.db.prepare(`
      INSERT INTO projects (id, name, description, status, start_date, end_date, budget, file_path, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      data.name,
      data.description || null,
      data.status || 'active',
      data.start_date || null,
      data.end_date || null,
      data.budget || null,
      data.file_path || null,
      data.metadata ? JSON.stringify(data.metadata) : null
    );
    return id;
  }

  updateProject(id, data) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      values.push(data.description);
    }
    if (data.status !== undefined) {
      fields.push('status = ?');
      values.push(data.status);
    }
    if (data.start_date !== undefined) {
      fields.push('start_date = ?');
      values.push(data.start_date);
    }
    if (data.end_date !== undefined) {
      fields.push('end_date = ?');
      values.push(data.end_date);
    }
    if (data.budget !== undefined) {
      fields.push('budget = ?');
      values.push(data.budget);
    }
    if (data.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(JSON.stringify(data.metadata));
    }

    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);
      const stmt = this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
    }
  }

  getOrCreateProject(name, filePath = null) {
    // First check by file path if provided
    if (filePath) {
      let project = this.db.prepare('SELECT id FROM projects WHERE file_path = ?').get(filePath);
      if (project) return project.id;
    }
    
    // Then check by name
    let project = this.db.prepare('SELECT id FROM projects WHERE name = ?').get(name);
    if (!project) {
      const id = this.createProject({ name, file_path: filePath });
      return id;
    }
    
    // Update file path if not set
    if (filePath && !project.file_path) {
      this.db.prepare('UPDATE projects SET file_path = ? WHERE id = ?').run(filePath, project.id);
    }
    
    return project.id;
  }

  // Parse project file and extract metadata
  async syncProjectFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    let updates = false;
    
    // Look for project ID in file
    let projectId = null;
    const idMatch = content.match(/<!-- project-id: ([a-f0-9]{32}) -->/);
    if (idMatch) {
      projectId = idMatch[1];
    }
    
    // Extract metadata from file
    const metadata = {
      dates: null,
      status: null,
      budget: null,
      location: null,
      urls: []
    };
    
    let projectName = null;
    let description = [];
    let inOverview = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Get project name from header
      if (i < 5 && line.match(/^#\s+(.+)/)) {
        projectName = line.match(/^#\s+(.+)/)[1];
      }
      
      // Extract metadata fields
      if (line.match(/^\*\*Dates?:\*\*/)) {
        metadata.dates = line.replace(/^\*\*Dates?:\*\*\s*/, '').trim();
      } else if (line.match(/^\*\*Status:\*\*/)) {
        metadata.status = line.replace(/^\*\*Status:\*\*\s*/, '').trim();
      } else if (line.match(/^\*\*Budget:\*\*/)) {
        const budgetStr = line.replace(/^\*\*Budget:\*\*\s*/, '').trim();
        const budgetMatch = budgetStr.match(/\$?([\d,]+)/);
        if (budgetMatch) {
          metadata.budget = parseFloat(budgetMatch[1].replace(/,/g, ''));
        }
      } else if (line.match(/^\*\*Location:\*\*/)) {
        metadata.location = line.replace(/^\*\*Location:\*\*\s*/, '').trim();
      }
      
      // Collect URLs
      const urlMatches = line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
      for (const match of urlMatches) {
        metadata.urls.push({ text: match[1], url: match[2] });
      }
      
      // Get overview section as description
      if (line.match(/^##\s+Overview/)) {
        inOverview = true;
      } else if (inOverview && line.match(/^##\s+/)) {
        inOverview = false;
      } else if (inOverview && line.trim()) {
        description.push(line);
      }
    }
    
    // If no project name found, use filename
    if (!projectName) {
      projectName = filePath.split('/').pop().replace('.md', '').replace(/-/g, ' ');
    }
    
    // Parse dates if found
    let startDate = null, endDate = null;
    if (metadata.dates) {
      const dateMatch = metadata.dates.match(/(\w+\s+\d{1,2})-(\d{1,2}),?\s+(\d{4})/);
      if (dateMatch) {
        const [_, monthDay1, day2, year] = dateMatch;
        const month = monthDay1.split(' ')[0];
        const day1 = monthDay1.split(' ')[1];
        startDate = `${year}-${this.monthToNumber(month)}-${day1.padStart(2, '0')}`;
        endDate = `${year}-${this.monthToNumber(month)}-${day2.padStart(2, '0')}`;
      }
    }
    
    // Get or create project
    if (projectId) {
      // Project has ID, update it
      const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      if (!project) {
        // Create with specific ID
        this.createProject({
          id: projectId,
          name: projectName,
          description: description.join('\n').trim(),
          status: metadata.status?.includes('BOOKED') ? 'confirmed' : 'active',
          start_date: startDate,
          end_date: endDate,
          budget: metadata.budget,
          file_path: filePath,
          metadata: metadata
        });
      } else {
        // Update existing
        this.updateProject(projectId, {
          name: projectName,
          description: description.join('\n').trim(),
          status: metadata.status?.includes('BOOKED') ? 'confirmed' : 'active',
          start_date: startDate,
          end_date: endDate,
          budget: metadata.budget,
          metadata: metadata
        });
      }
    } else {
      // No ID in file, check if project exists
      const existingProject = this.db.prepare('SELECT id FROM projects WHERE file_path = ?').get(filePath);
      if (existingProject) {
        projectId = existingProject.id;
        // Update project
        this.updateProject(projectId, {
          name: projectName,
          description: description.join('\n').trim(),
          status: metadata.status?.includes('BOOKED') ? 'confirmed' : 'active',
          start_date: startDate,
          end_date: endDate,
          budget: metadata.budget,
          metadata: metadata
        });
      } else {
        // Create new project
        projectId = this.createProject({
          name: projectName,
          description: description.join('\n').trim(),
          status: metadata.status?.includes('BOOKED') ? 'confirmed' : 'active',
          start_date: startDate,
          end_date: endDate,
          budget: metadata.budget,
          file_path: filePath,
          metadata: metadata
        });
        
        // Add project ID to file
        const firstLineIdx = lines.findIndex(l => l.trim());
        if (firstLineIdx !== -1) {
          lines.splice(firstLineIdx + 1, 0, `<!-- project-id: ${projectId} -->`);
          await fs.writeFile(filePath, lines.join('\n'));
          updates = true;
        }
      }
    }
    
    return { projectId, updates };
  }

  monthToNumber(month) {
    const months = {
      'January': '01', 'February': '02', 'March': '03', 'April': '04',
      'May': '05', 'June': '06', 'July': '07', 'August': '08',
      'September': '09', 'October': '10', 'November': '11', 'December': '12',
      'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
      'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
      'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
    };
    return months[month] || '01';
  }

  // Markdown sync tracking
  recordMarkdownSync(filePath, taskId, lineNumber = null) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO markdown_sync (file_path, task_id, line_number, last_synced)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(filePath, taskId, lineNumber);
  }

  getMarkdownTasks(filePath) {
    return this.db.prepare(`
      SELECT t.*, ms.line_number
      FROM tasks t
      JOIN markdown_sync ms ON t.id = ms.task_id
      WHERE ms.file_path = ?
      ORDER BY ms.line_number
    `).all(filePath);
  }

  // Parse markdown file and sync tasks
  async syncMarkdownFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const updates = [];
    const seenTaskIds = new Set();

    // Sync project file first if it's a project
    let projectId = null;
    if (filePath.startsWith('projects/')) {
      const projectResult = await this.syncProjectFile(filePath);
      projectId = projectResult.projectId;
      if (projectResult.updates) {
        // File was updated with project ID, reload content
        const updatedContent = await fs.readFile(filePath, 'utf-8');
        lines.splice(0, lines.length, ...updatedContent.split('\n'));
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const taskMatch = line.match(/^- \[([ x])\] (.+?)(?:<!-- task-id: ([a-f0-9]{32}) -->)?$/);
      
      if (taskMatch) {
        const isCompleted = taskMatch[1] === 'x';
        const title = taskMatch[2].trim();
        const existingId = taskMatch[3];

        let taskId;
        if (existingId) {
          // Update existing task
          taskId = existingId;
          const task = this.getTask(taskId);
          if (task) {
            const newStatus = isCompleted ? '✅ Done' : (task.status === '✅ Done' ? 'Next Up' : task.status);
            const updates = {};
            if (task.title !== title) updates.title = title;
            if (task.status !== newStatus) updates.status = newStatus;
            if (projectId && task.project_id !== projectId) updates.project_id = projectId;
            
            if (Object.keys(updates).length > 0) {
              this.updateTask(taskId, updates);
            }
          }
        } else {
          // Create new task
          taskId = this.createTask({
            title,
            status: isCompleted ? '✅ Done' : '🎭 Stage',
            project_id: projectId
          });
          
          // Add task ID to the line
          lines[i] = `${line} <!-- task-id: ${taskId} -->`;
          updates.push({ line: i, content: lines[i] });
        }

        seenTaskIds.add(taskId);
        this.recordMarkdownSync(filePath, taskId, i + 1);
      }
    }

    // Write back to file if we added IDs
    if (updates.length > 0) {
      await fs.writeFile(filePath, lines.join('\n'));
    }

    // Get all tasks previously synced with this file
    const previousTasks = this.getMarkdownTasks(filePath);
    
    // Find tasks that were removed from the markdown
    for (const task of previousTasks) {
      if (!seenTaskIds.has(task.id)) {
        // Task was removed from markdown, archive it
        this.updateTask(task.id, { status: '✅ Done' });
        this.db.prepare('DELETE FROM markdown_sync WHERE file_path = ? AND task_id = ?')
          .run(filePath, task.id);
      }
    }

    return updates.length;
  }

  // Generate all active tasks file (bidirectional sync)
  // This reads the existing tasks.md first to capture any manual checkbox changes,
  // applies them to the database, then regenerates the file with all active tasks
  async generateAllTasksFile(outputPath = 'notes/tasks/tasks.md') {
    // First, check if tasks.md exists and read any manual changes
    const manualChanges = new Map();
    
    try {
      const existingContent = await fs.readFile(outputPath, 'utf-8');
      const existingLines = existingContent.split('\n');
      
      // Parse existing file for checkbox states
      for (const line of existingLines) {
        const taskMatch = line.match(/^- \[([ x])\] .+?<!-- task-id: ([a-f0-9]{32}) -->/);
        if (taskMatch) {
          const isChecked = taskMatch[1] === 'x';
          const taskId = taskMatch[2];
          manualChanges.set(taskId, isChecked);
        }
      }
      
      // Apply manual changes to database before regenerating
      for (const [taskId, isChecked] of manualChanges) {
        const task = this.getTask(taskId);
        if (task) {
          const shouldBeDone = isChecked;
          const isDone = task.status === '✅ Done';
          
          if (shouldBeDone && !isDone) {
            // User checked the box, mark as done
            this.updateTask(taskId, { status: '✅ Done' });
            console.log(`✓ Marked task as done: ${task.title}`);
          } else if (!shouldBeDone && isDone) {
            // User unchecked the box, mark as not done
            this.updateTask(taskId, { status: '🎭 Stage' });
            console.log(`↺ Marked task as not done: ${task.title}`);
          }
        }
      }
    } catch (err) {
      // File doesn't exist yet, that's OK
    }

    // Get all active tasks (not Done) with project information
    const tasks = this.db.prepare(`
      SELECT t.*, p.name as project_name 
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.status != '✅ Done'
      ORDER BY p.name ASC, t.do_date ASC, t.status ASC, t.title ASC
    `).all();
    
    const lines = [];
    
    // Group tasks by project
    const tasksByProject = {};
    const noProjectTasks = [];
    
    for (const task of tasks) {
      if (task.project_id && task.project_name) {
        if (!tasksByProject[task.project_name]) {
          tasksByProject[task.project_name] = [];
        }
        tasksByProject[task.project_name].push(task);
      } else {
        noProjectTasks.push(task);
      }
    }
    
    // Add tasks without projects first
    if (noProjectTasks.length > 0) {
      lines.push('## General Tasks');
      lines.push('');
      for (const task of noProjectTasks) {
        const checkbox = task.status === '✅ Done' ? 'x' : ' ';
        const tags = this.getTaskTags(task.id);
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        lines.push(`- [${checkbox}] ${task.title}${tagStr} <!-- task-id: ${task.id} -->`);
      }
      lines.push('');
    }
    
    // Add tasks grouped by project
    const projectNames = Object.keys(tasksByProject).sort();
    for (const projectName of projectNames) {
      lines.push(`## ${projectName}`);
      lines.push('');
      for (const task of tasksByProject[projectName]) {
        const checkbox = task.status === '✅ Done' ? 'x' : ' ';
        const tags = this.getTaskTags(task.id);
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        lines.push(`- [${checkbox}] ${task.title}${tagStr} <!-- task-id: ${task.id} -->`);
      }
      lines.push('');
    }
    
    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    
    await fs.writeFile(outputPath, lines.join('\n'));
    return tasks.length;
  }

  // Generate today's task file (bidirectional sync)
  // This reads the existing today.md first to capture any manual checkbox changes,
  // applies them to the database, then regenerates the file with all today's tasks
  async generateTodayFile(outputPath = 'notes/tasks/today.md') {
    // First, check if today.md exists and read any manual changes
    const manualChanges = new Map();
    try {
      const existingContent = await fs.readFile(outputPath, 'utf-8');
      const existingLines = existingContent.split('\n');
      
      // Parse existing file for checkbox states
      for (const line of existingLines) {
        const taskMatch = line.match(/^- \[([ x])\] .+?<!-- task-id: ([a-f0-9]{32}) -->/);
        if (taskMatch) {
          const isChecked = taskMatch[1] === 'x';
          const taskId = taskMatch[2];
          manualChanges.set(taskId, isChecked);
        }
      }
      
      // Apply manual changes to database before regenerating
      for (const [taskId, isChecked] of manualChanges) {
        const task = this.getTask(taskId);
        if (task) {
          const shouldBeDone = isChecked;
          const isDone = task.status === '✅ Done';
          
          if (shouldBeDone && !isDone) {
            // User checked the box, mark as done
            this.updateTask(taskId, { status: '✅ Done' });
            console.log(`✓ Marked task as done: ${task.title}`);
          } else if (!shouldBeDone && isDone) {
            // User unchecked the box, mark as not done
            this.updateTask(taskId, { status: '🎭 Stage' });
            console.log(`↺ Marked task as not done: ${task.title}`);
          }
        }
      }
    } catch (err) {
      // File doesn't exist yet, that's OK
    }

    // Now generate the file with updated data
    const tasks = this.getTodayTasks();
    const lines = ['# Today\'s Tasks', '', `*Generated: ${new Date().toLocaleString()}*`, ''];

    // Group by status (derived priority)
    const priorities = {
      5: '🔴 Critical',
      4: '🟠 High',
      3: '🟡 Medium',
      2: '🔵 Low',
      1: '⚪ Very Low'
    };

    for (const [level, label] of Object.entries(priorities).reverse()) {
      const priorityTasks = tasks.filter(t => this.getPriorityFromStatus(t.status) == level);
      if (priorityTasks.length > 0) {
        lines.push(`## ${label}`, '');
        for (const task of priorityTasks) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          const tags = task.tags.length > 0 ? ` [${task.tags.join(', ')}]` : '';
          lines.push(`- [${checkbox}] ${task.title}${tags} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
    }

    await fs.writeFile(outputPath, lines.join('\n'));
    return tasks.length;
  }

  // Handle repeating tasks
  processRepeatingTasks() {
    const today = new Date().toISOString().split('T')[0];
    const repeatingTasks = this.db.prepare(`
      SELECT t.*, 
             MAX(tc.completed_at) as last_completed
      FROM tasks t
      LEFT JOIN task_completions tc ON t.id = tc.task_id
      WHERE t.repeat_interval IS NOT NULL 
        AND t.status = '✅ Done'
      GROUP BY t.id
    `).all();

    let created = 0;
    for (const task of repeatingTasks) {
      // Calculate next date based on last completion
      const nextDate = this.calculateNextDateFromInterval(task.last_completed || task.completed_at, task.repeat_interval);
      
      // Only create if the next date is today or earlier
      if (nextDate <= today) {
        // Check if we already created this recurring instance today
        const existingToday = this.db.prepare(`
          SELECT id FROM tasks 
          WHERE title = ? 
            AND do_date = ?
            AND stage != 'done'
            AND stage != 'archived'
        `).get(task.title, nextDate);
        
        if (!existingToday) {
          // Create new task instance
          this.createTask({
            title: task.title,
            description: task.description,
            do_date: nextDate,
            status: '🎭 Stage',
            stage: null,
            project_id: task.project_id,
            repeat_interval: task.repeat_interval,
            tags: this.getTaskTags(task.id)
          });
          created++;

          // Update the original task's repeat_next_date
          this.db.prepare('UPDATE tasks SET repeat_next_date = ? WHERE id = ?')
            .run(nextDate, task.id);
        }
      }
    }

    return created;
  }

  calculateNextDate(fromDate, frequency) {
    const date = new Date(fromDate || new Date());
    
    switch (frequency) {
      case 'daily':
        date.setDate(date.getDate() + 1);
        break;
      case 'weekly':
        date.setDate(date.getDate() + 7);
        break;
      case 'monthly':
        date.setMonth(date.getMonth() + 1);
        break;
      case 'yearly':
        date.setFullYear(date.getFullYear() + 1);
        break;
      default:
        // Could support cron expressions here
        date.setDate(date.getDate() + 1);
    }
    
    return date.toISOString().split('T')[0];
  }

  calculateNextDateFromInterval(completedDate, interval) {
    const date = completedDate ? new Date(completedDate) : new Date();
    if (interval && interval > 0) {
      date.setDate(date.getDate() + interval);
    } else {
      date.setDate(date.getDate() + 1); // Default to daily
    }
    return date.toISOString().split('T')[0];
  }

  getPriorityFromStatus(status) {
    // Derive priority from status
    switch (status) {
      case '🔥 Immediate':
        return 5; // Critical priority
      case '🚀 1st Priority':
        return 4; // High priority
      case '🎭 Stage':
        return 3; // Medium priority
      case '3rd Priority':
        return 3; // Medium priority
      case 'Waiting':
      case '⏳ Waiting':
        return 2; // Low priority
      case '✅ Done':
        return 1; // Very low (completed)
      default:
        return 3; // Default to medium
    }
  }

  close() {
    this.db.close();
  }
}