import crypto from 'crypto';
import fs from 'fs/promises';
import { getDatabaseSync, forcePushToTurso } from './database-sync.js';
import { DateParser } from './date-parser.js';

export class TaskManager {
  constructor(dbPath = '.data/today.db', options = {}) {
    // Use DatabaseSync wrapper for automatic Turso sync
    // Pass readOnly option to skip Turso initialization for read-only operations
    this.db = getDatabaseSync(dbPath, { readOnly: options.readOnly || false });
    this.dateParser = new DateParser();
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

    // Create topics table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT UNIQUE NOT NULL,
        color TEXT
      )
    `);

    // Create task_topics junction table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_topics (
        task_id TEXT,
        topic_id TEXT,
        PRIMARY KEY (task_id, topic_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
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
      CREATE INDEX IF NOT EXISTS idx_task_topics_task ON task_topics(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_topics_topic ON task_topics(topic_id);
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

    // Create sync_log table for bin/today script
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sync_type TEXT,
        status TEXT,
        details TEXT
      );
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

    // Add topics if provided
    if (data.topics && data.topics.length > 0) {
      this.setTaskTopics(id, data.topics);
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
        // Record completion in history for ALL tasks (not just repeating)
        // This ensures we have accurate completion tracking for the Done Today section
        this.db.prepare('INSERT INTO task_completions (task_id) VALUES (?)').run(id);
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

    // Update topics if provided
    if (data.topics !== undefined) {
      this.setTaskTopics(id, data.topics);
    }
  }

  // Get a task by ID
  getTask(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (task) {
      task.topics = this.getTaskTopics(id);
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
      topics: this.getTaskTopics(task.id)
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
      topics: this.getTaskTopics(task.id)
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
      topics: this.getTaskTopics(task.id)
    }));
  }

  // Topic management
  createTopic(name, color = null) {
    const id = this.generateId();
    const stmt = this.db.prepare('INSERT INTO topics (id, name, color) VALUES (?, ?, ?)');
    stmt.run(id, name, color);
    return id;
  }

  getOrCreateTopic(name) {
    let topic = this.db.prepare('SELECT id FROM topics WHERE name = ?').get(name);
    if (!topic) {
      const id = this.createTopic(name);
      return id;
    }
    return topic.id;
  }

  setTaskTopics(taskId, topicNames) {
    // Remove existing topics
    this.db.prepare('DELETE FROM task_topics WHERE task_id = ?').run(taskId);

    // Add new topics
    const stmt = this.db.prepare('INSERT INTO task_topics (task_id, topic_id) VALUES (?, ?)');
    for (const topicName of topicNames) {
      const topicId = this.getOrCreateTopic(topicName);
      stmt.run(taskId, topicId);
    }
  }

  addTopicToTask(taskId, topicName) {
    // Add a single topic to a task without removing existing ones
    const topicId = this.getOrCreateTopic(topicName);
    
    // Check if this topic is already assigned to the task
    const existing = this.db.prepare(
      'SELECT 1 FROM task_topics WHERE task_id = ? AND topic_id = ?'
    ).get(taskId, topicId);
    
    if (!existing) {
      this.db.prepare('INSERT INTO task_topics (task_id, topic_id) VALUES (?, ?)')
        .run(taskId, topicId);
    }
  }

  getTaskTopics(taskId) {
    return this.db.prepare(`
      SELECT t.name 
      FROM topics t 
      JOIN task_topics tt ON t.id = tt.topic_id 
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
    
    // Get file modification time
    const stats = await fs.stat(filePath);
    const fileModTime = stats.mtime;

    // Check if this is a review file and extract the date
    let reviewDate = null;
    if (filePath.startsWith('plans/')) {
      const dateMatch = filePath.match(/(\d{4}-Q\d+-\d{2}-\d{2})\.md$/);  
      if (dateMatch) {
        reviewDate = dateMatch[1];
      }
    }
    
    // Check if this is a topic file and extract the topic
    let topicName = null;
    if (filePath.startsWith('topics/')) {
      // Read the first line to get the topic name
      const firstLine = lines.find(line => line.startsWith('# '));
      if (firstLine) {
        topicName = firstLine.replace(/^#\s+/, '').trim();
      }
    }

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
      // Match both normal and corrupted comment formats (em-dashes from formatters)
      const taskMatch = line.match(/^- \[([ x])\] (.+?)(?:<![-—]+ task-id: ([a-f0-9]{32}) [-—]+>)?$/);
      
      if (taskMatch) {
        const isCompleted = taskMatch[1] === 'x';
        let title = taskMatch[2].trim();
        const existingId = taskMatch[3];

        // Remove any topic tags from the title (e.g., [Health], [Programming])
        // These are stored separately in the database and shouldn't be in the title
        title = title.replace(/\s*\[[^\]]+\]/g, '').trim();

        // Parse date topics from title
        let extractedDate = null;
        const dateTags = this.dateParser.extractDateTags(title);
        if (dateTags.length > 0) {
          // Use the first date tag found
          extractedDate = dateTags[0].parsed;
          // Remove all date topics from the title
          title = this.dateParser.removeTagsFromText(title, dateTags);
        }

        let taskId;
        if (existingId) {
          // Update existing task
          taskId = existingId;
          const task = this.getTask(taskId);
          if (task) {
            // Check if markdown file is newer than database update
            const taskUpdateTime = task.updated_at ? new Date(task.updated_at) : new Date(0);
            const markdownIsNewer = fileModTime > taskUpdateTime;
            
            // Only sync from markdown if the file is newer than the database
            if (markdownIsNewer) {
              const newStatus = isCompleted ? '✅ Done' : (task.status === '✅ Done' ? 'Next Up' : task.status);
              const updates = {};
              
              // Only update title and do_date if title has changed
              if (task.title !== title) {
                updates.title = title;
                // If title changed and has date tag, update do_date
                if (extractedDate && !reviewDate) {
                  updates.do_date = extractedDate;
                }
              }
              
              if (task.status !== newStatus) updates.status = newStatus;
              if (projectId && task.project_id !== projectId) updates.project_id = projectId;
              
              // For review files, set do_date for uncompleted tasks if not already set
              if (reviewDate && !isCompleted && !task.do_date) {
                updates.do_date = reviewDate;
              }
              
              if (Object.keys(updates).length > 0) {
                this.updateTask(taskId, updates);
              }
            }
          }
        } else {
          // Create new task
          const taskData = {
            title,
            status: isCompleted ? '✅ Done' : '🎭 Stage',
            project_id: projectId
          };
          
          // Set do_date from extracted date tag, review date, or neither
          if (extractedDate && !reviewDate) {
            taskData.do_date = extractedDate;
          } else if (reviewDate && !isCompleted) {
            taskData.do_date = reviewDate;
          }
          
          taskId = this.createTask(taskData);
          
          // If this is a topic file, automatically assign the topic to the new task
          if (topicName) {
            this.addTopicToTask(taskId, topicName);
          }
          
          // Add task ID to the line (strip any corrupted comments first)
          const cleanLine = line.replace(/<![-—]+ task-id: [a-f0-9]{32} [-—]+>/g, '');
          lines[i] = `${cleanLine} <!-- task-id: ${taskId} -->`;
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

  // Generate all active tasks file
  // Note: Checkbox syncing is handled separately, not during generation
  async generateAllTasksFile(outputPath = 'notes/tasks/tasks.md') {

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
    
    // Helper function to group tasks by date
    const groupTasksByDate = (tasks) => {
      const tasksByDate = {};
      const noDateTasks = [];
      
      for (const task of tasks) {
        if (task.do_date) {
          if (!tasksByDate[task.do_date]) {
            tasksByDate[task.do_date] = [];
          }
          tasksByDate[task.do_date].push(task);
        } else {
          noDateTasks.push(task);
        }
      }
      
      return { tasksByDate, noDateTasks };
    };
    
    // Helper function to format date header
    const formatDateHeader = (dateStr) => {
      const date = new Date(dateStr + 'T00:00:00');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const diffDays = Math.floor((date - today) / (1000 * 60 * 60 * 24));
      
      const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
      const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      
      if (diffDays === 0) return `### Today - ${dayName}, ${monthDay}`;
      if (diffDays === -1) return `### Yesterday - ${dayName}, ${monthDay}`;
      if (diffDays === 1) return `### Tomorrow - ${dayName}, ${monthDay}`;
      if (diffDays < -1 && diffDays >= -7) return `### ${dayName}, ${monthDay} (${Math.abs(diffDays)} days ago)`;
      if (diffDays < -7) return `### ${dayName}, ${monthDay} (overdue)`;
      if (diffDays > 1 && diffDays <= 7) return `### ${dayName}, ${monthDay} (in ${diffDays} days)`;
      return `### ${dayName}, ${monthDay}`;
    };
    
    // Add tasks without projects first
    if (noProjectTasks.length > 0) {
      lines.push('<details>');
      lines.push(`<summary><strong>General Tasks</strong> (${noProjectTasks.length} tasks)</summary>`);
      lines.push('');
      
      const { tasksByDate, noDateTasks } = groupTasksByDate(noProjectTasks);
      
      // Sort dates and add tasks for each date
      const sortedDates = Object.keys(tasksByDate).sort();
      for (const date of sortedDates) {
        lines.push(formatDateHeader(date));
        lines.push('');
        for (const task of tasksByDate[date]) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          const topics = this.getTaskTopics(task.id);
          const topicStr = topics.length > 0 ? ` [${topics.join(', ')}]` : '';
          lines.push(`- [${checkbox}] ${task.title}${topicStr} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
      
      // Add tasks with no date
      if (noDateTasks.length > 0) {
        lines.push('### No Date Set');
        lines.push('');
        for (const task of noDateTasks) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          const topics = this.getTaskTopics(task.id);
          const topicStr = topics.length > 0 ? ` [${topics.join(', ')}]` : '';
          lines.push(`- [${checkbox}] ${task.title}${topicStr} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
      
      lines.push('</details>');
      lines.push('');
    }
    
    // Add tasks grouped by project
    const projectNames = Object.keys(tasksByProject).sort();
    for (const projectName of projectNames) {
      const projectTasks = tasksByProject[projectName];
      lines.push('<details>');
      lines.push(`<summary><strong>${projectName}</strong> (${projectTasks.length} tasks)</summary>`);
      lines.push('');
      
      const { tasksByDate, noDateTasks } = groupTasksByDate(projectTasks);
      
      // Sort dates and add tasks for each date
      const sortedDates = Object.keys(tasksByDate).sort();
      for (const date of sortedDates) {
        lines.push(formatDateHeader(date));
        lines.push('');
        for (const task of tasksByDate[date]) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          const topics = this.getTaskTopics(task.id);
          const topicStr = topics.length > 0 ? ` [${topics.join(', ')}]` : '';
          lines.push(`- [${checkbox}] ${task.title}${topicStr} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
      
      // Add tasks with no date
      if (noDateTasks.length > 0) {
        lines.push('### No Date Set');
        lines.push('');
        for (const task of noDateTasks) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          const topics = this.getTaskTopics(task.id);
          const topicStr = topics.length > 0 ? ` [${topics.join(', ')}]` : '';
          lines.push(`- [${checkbox}] ${task.title}${topicStr} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
      
      lines.push('</details>');
      lines.push('');
    }
    
    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    
    await fs.writeFile(outputPath, lines.join('\n'));
    return tasks.length;
  }

  // Generate today's task file
  // Note: Checkbox syncing is handled separately, not during generation
  async generateTodayFile(outputPath = 'notes/tasks/today.md') {
    // Check if file was recently modified (within last 5 seconds)
    // This prevents overwriting manual edits that just happened
    try {
      const stats = await fs.stat(outputPath);
      const timeSinceModified = Date.now() - stats.mtime.getTime();
      if (timeSinceModified < 5000) {
        // File was just edited, skip regeneration to preserve manual changes
        console.log('  • Skipping today.md regeneration (file was just edited)');
        return 0;
      }
    } catch (err) {
      // File doesn't exist yet, continue with generation
    }

    // Get today's date
    const today = new Date().toISOString().split('T')[0];
    
    // Get active tasks for today (not done)
    const activeTasks = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE (do_date = ? OR do_date < ?)
        AND status != '✅ Done'
      ORDER BY do_date ASC, status ASC
    `).all(today, today).map(task => ({
      ...task,
      topics: this.getTaskTopics(task.id)
    }));
    
    // Get tasks ACTUALLY completed today using task_completions table
    // This avoids showing tasks with bulk-updated completed_at timestamps
    const completedTasks = this.db.prepare(`
      SELECT DISTINCT t.* 
      FROM tasks t
      INNER JOIN task_completions tc ON t.id = tc.task_id
      WHERE DATE(tc.completed_at) = DATE(?)
      ORDER BY tc.completed_at DESC
    `).all(today).map(task => ({
      ...task,
      topics: this.getTaskTopics(task.id)
    }));
    
    // Use Eastern timezone for timestamp
    const now = new Date();
    const easternTime = now.toLocaleString('en-US', { 
      timeZone: 'America/New_York',
      month: 'numeric',
      day: 'numeric', 
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    const timeZone = now.toLocaleString('en-US', { 
      timeZone: 'America/New_York', 
      timeZoneName: 'short' 
    }).split(' ').pop();
    
    const lines = ['# Today\'s Tasks', '', `*Generated: ${easternTime} ${timeZone}*`, ''];

    // Group tasks by status
    const tasksByStatus = {};
    for (const task of activeTasks) {
      const status = task.status || '🎭 Stage';
      if (!tasksByStatus[status]) {
        tasksByStatus[status] = [];
      }
      tasksByStatus[status].push(task);
    }

    // Define priority order for known statuses (those we want at the top)
    const priorityStatuses = ['🔥 Immediate', '🔥 Today', '🚀 1st Priority', '2nd Priority', '3rd Priority', '4th Priority', '5th Priority'];
    
    // Get all unique statuses from the tasks, sorted
    const allStatuses = Object.keys(tasksByStatus).sort((a, b) => {
      // First sort by priority order if defined
      const aPriority = priorityStatuses.indexOf(a);
      const bPriority = priorityStatuses.indexOf(b);
      
      if (aPriority !== -1 && bPriority !== -1) {
        return aPriority - bPriority;
      }
      if (aPriority !== -1) return -1;
      if (bPriority !== -1) return 1;
      
      // Then sort alphabetically for other statuses
      return a.localeCompare(b);
    });

    // Output tasks grouped by status
    for (const status of allStatuses) {
      lines.push(`## ${status}`, '');
      for (const task of tasksByStatus[status]) {
        const topics = task.topics.length > 0 ? ` [${task.topics.join(', ')}]` : '';
        lines.push(`- [ ] ${task.title}${topics} <!-- task-id: ${task.id} -->`);
      }
      lines.push('');
    }
    
    // Add completed tasks in a collapsible Done section
    if (completedTasks.length > 0) {
      lines.push('<details>');
      lines.push(`<summary><strong>✅ Done Today</strong> (${completedTasks.length} tasks completed)</summary>`);
      lines.push('');
      for (const task of completedTasks) {
        const topics = task.topics.length > 0 ? ` [${task.topics.join(', ')}]` : '';
        lines.push(`- [x] ${task.title}${topics} <!-- task-id: ${task.id} -->`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    await fs.writeFile(outputPath, lines.join('\n'));
    return activeTasks.length + completedTasks.length;
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
            topics: this.getTaskTopics(task.id)
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

  // Generate topic files with their associated tasks
  async generateTopicFiles() {
    const fs = await import('fs').then(m => m.promises);
    const path = await import('path');
    
    // Get all topics with active tasks
    const topicsWithTasks = this.db.prepare(`
      SELECT DISTINCT t.id, t.name
      FROM topics t
      JOIN task_topics tt ON t.id = tt.topic_id
      JOIN tasks tk ON tt.task_id = tk.id
      WHERE tk.status != '✅ Done'
      ORDER BY t.name
    `).all();
    
    if (topicsWithTasks.length === 0) {
      return 0;
    }
    
    // Ensure topics directory exists
    const topicsDir = 'topics';
    try {
      await fs.mkdir(topicsDir, { recursive: true });
    } catch (e) {
      // Directory may already exist
    }
    
    let generatedCount = 0;
    
    for (const topic of topicsWithTasks) {
      // Convert topic name to filename (lowercase, replace spaces with hyphens)
      const filename = topic.name.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-')          // Replace spaces with hyphens
        .replace(/-+/g, '-')           // Replace multiple hyphens with single
        .replace(/^-|-$/g, '');        // Remove leading/trailing hyphens
      
      const filePath = path.join(topicsDir, `${filename}.md`);
      
      // Get tasks for this topic
      const tasks = this.db.prepare(`
        SELECT tk.*
        FROM tasks tk
        JOIN task_topics tt ON tk.id = tt.task_id
        WHERE tt.topic_id = ?
          AND tk.status != '✅ Done'
        ORDER BY tk.do_date ASC, tk.status ASC, tk.title ASC
      `).all(topic.id);
      
      // Check if file exists and has custom content
      let hasCustomContent = false;
      let existingContent = '';
      try {
        existingContent = await fs.readFile(filePath, 'utf-8');
        // Check if this is a generated file or has custom content
        const tasksMarker = '## Tasks';
        const markerIndex = existingContent.indexOf(tasksMarker);
        if (markerIndex > 0) {
          // Keep everything before the Tasks section
          existingContent = existingContent.substring(0, markerIndex).trimEnd();
          // Remove any trailing horizontal rules that would duplicate
          existingContent = existingContent.replace(/(\n---\s*)+$/, '');
          hasCustomContent = true;
        }
      } catch (e) {
        // File doesn't exist, will create new one
      }
      
      const lines = [];
      
      if (hasCustomContent) {
        // Use existing content
        lines.push(existingContent);
      } else {
        // Create default structure
        lines.push(`# ${topic.name}`);
        lines.push('');
        lines.push('## Overview');
        lines.push('');
        lines.push(`Tasks and projects related to ${topic.name}.`);
        lines.push('');
      }
      
      // Add the tasks section
      lines.push('---');
      lines.push('');
      lines.push('## Tasks');
      lines.push('');
      lines.push('<!-- Tasks for this topic will be automatically populated by bin/tasks sync -->');
      lines.push('<!-- Do not edit below this line - tasks are managed by the sync system -->');
      lines.push('');
      
      // Group tasks by date
      const tasksByDate = {};
      const noDateTasks = [];
      
      for (const task of tasks) {
        if (task.do_date) {
          if (!tasksByDate[task.do_date]) {
            tasksByDate[task.do_date] = [];
          }
          tasksByDate[task.do_date].push(task);
        } else {
          noDateTasks.push(task);
        }
      }
      
      // Add tasks with dates
      const sortedDates = Object.keys(tasksByDate).sort();
      for (const date of sortedDates) {
        const dateObj = new Date(date + 'T00:00:00');
        const dateStr = dateObj.toLocaleDateString('en-US', { 
          weekday: 'short', 
          month: 'short', 
          day: 'numeric' 
        });
        lines.push(`### ${dateStr}`);
        lines.push('');
        
        for (const task of tasksByDate[date]) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          // Don't add topic tags in topic files - they're redundant
          lines.push(`- [${checkbox}] ${task.title} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
      
      // Add tasks without dates
      if (noDateTasks.length > 0) {
        lines.push('### No Date Set');
        lines.push('');
        for (const task of noDateTasks) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          lines.push(`- [${checkbox}] ${task.title} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
      
      // Remove trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      
      await fs.writeFile(filePath, lines.join('\n'));
      generatedCount++;
    }
    
    return generatedCount;
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