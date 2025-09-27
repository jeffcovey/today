// Task management service for database operations
// Note: Markdown sync operations using task-id comments are deprecated
// New markdown tasks are managed through the markdown_tasks cache table

import crypto from 'crypto';
import fs from 'fs/promises';
import { getDatabase } from './database-service.js';
import { DateParser } from './date-parser.js';
import { getTopicEmoji } from './tag-emoji-mappings.js';

export class TaskManager {
  constructor(dbPath = '.data/today.db', options = {}) {
    // Use unified DatabaseService for all database access
    // Pass readOnly option to skip Turso sync for read-only operations
    this.db = getDatabase(dbPath, { readOnly: options.readOnly || false });
    this.dateParser = new DateParser();
    // DO NOT recreate schema - database already exists with correct schema from Turso
    // Schema is managed by migrations and Turso sync, not by this module
    
    // Topic to emoji mapping is now handled by tag-emoji-mappings.js
    // Keeping this for backward compatibility
    this.topicEmojis = {
      // Home & Household
      'Home/Household': '🏠',
      'Home': '🏠',
      'Household': '🏠',
      'Cleaning': '🧹',
      'Maintenance': '🔧',
      'Repairs': '🔨',

      // Yard & Outdoor
      'Yard/Pool/Landscaping': '🌳',
      'Yard': '🌳',
      'Pool': '🏊',
      'Landscaping': '🌿',
      'Garden': '🌱',
      'Lawn': '🌾',
      
      // Finance & Business
      'Finance': '💰',
      'Money': '💵',
      'Budget': '📊',
      'Investment': '📈',
      'Business': '💼',
      'Work': '💼',
      
      // Health & Wellness
      'Health': '🏥',
      'Medical': '⚕️',
      'Fitness': '💪',
      'Exercise': '🏃',
      'Wellness': '🧘',
      'Mental Health': '🧠',
      
      // Personal & Family
      'Personal': '👤',
      'Family': '👨‍👩‍👧‍👦',
      'Kids': '👶',
      'Pets': '🐾',
      'Relationships': '❤️',
      
      // Projects & Learning
      'Projects': '📁',
      'Learning': '📚',
      'Education': '🎓',
      'Study': '📖',
      'Research': '🔬',
      'Development': '💻',
      'Programming': '💻',
      'Code': '💻',
      
      // Admin & Organization
      'Admin': '📋',
      'Organization': '🗂️',
      'Planning': '📅',
      'Schedule': '📆',
      'Meetings': '🤝',
      
      // Shopping & Errands
      'Shopping': '🛒',
      'Groceries': '🛒',
      'Errands': '🚗',
      'Travel': '✈️',
      'Transportation': '🚌',
      
      // Entertainment & Hobbies
      'Entertainment': '🎬',
      'Hobbies': '🎨',
      'Games': '🎮',
      'Music': '🎵',
      'Reading': '📚',
      'Sports': '⚽',
      
      // Technology
      'Technology': '🖥️',
      'Tech': '🖥️',
      'Devices': '📱',
      'Software': '💾',
      'Internet': '🌐',
      
      // Communication
      'Email': '📧',
      'Phone': '📞',
      'Communication': '💬',
      'Social': '👥',
      
    };
  }
  
  // Get emoji for a topic name
  getTopicEmoji(topicName) {
    // Use the shared getTopicEmoji function from tag-emoji-mappings.js
    const emoji = getTopicEmoji(topicName);
    if (emoji) return emoji;

    // Fall back to legacy mappings if needed
    // Try exact match first
    if (this.topicEmojis[topicName]) {
      return this.topicEmojis[topicName];
    }

    // Try case-insensitive match
    const lowerName = topicName.toLowerCase();
    for (const [key, emoji] of Object.entries(this.topicEmojis)) {
      if (key.toLowerCase() === lowerName) {
        return emoji;
      }
    }

    // Try partial match (for compound topics like "Yard/Pool/Landscaping")
    for (const [key, emoji] of Object.entries(this.topicEmojis)) {
      if (topicName.includes(key) || key.includes(topicName)) {
        return emoji;
      }
    }

    // No emoji for unknown topics
    return '';
  }
  
  // Format topics as emoji string
  formatTopicsAsEmojis(topicNames) {
    if (!topicNames || topicNames.length === 0) {
      return '';
    }
    
    const emojis = topicNames.map(name => this.getTopicEmoji(name));
    // Remove duplicates and join
    const uniqueEmojis = [...new Set(emojis)];
    return ' ' + uniqueEmojis.join('');
  }

  // DEPRECATED - Do not use. Schema is managed by migrations and Turso sync
  // This method was recreating tables with simplified schema and losing data
  initDatabase_DEPRECATED() {
    throw new Error('initDatabase() is deprecated. Database schema should already exist from Turso sync.');
    // Original code kept below for reference only
    // Disable foreign keys to avoid issues during sync
    // this.db.exec('PRAGMA foreign_keys = OFF');
    
    // Create tasks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        title TEXT NOT NULL,
        description TEXT,
        content TEXT,
        do_date DATE,
        status TEXT DEFAULT '🗂️ To File',
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

    // Task completions are now tracked in tasks.completed_at

    // Create indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_do_date ON tasks(do_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(stage);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_task_topics_task ON task_topics(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_topics_topic ON task_topics(topic_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at);
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
    // this.db.exec(`
    //   CREATE TABLE IF NOT EXISTS sync_log (
    //     id INTEGER PRIMARY KEY AUTOINCREMENT,
    //     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    //     sync_type TEXT,
    //     status TEXT,
    //     details TEXT
    //   );
    // `);
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
      data.status || '🗂️ To File',
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
      
      // Only update completed_at when transitioning TO or FROM done status
      // Get the current task status to check for state transition
      const currentTask = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
      
      if (currentTask) {
        const wasCompleted = currentTask.status === '✅ Done';
        const isNowCompleted = data.status === '✅ Done';
        
        // Only set completed_at when transitioning from not-done to done
        // This handles both first-time completions and repeating task completions
        if (!wasCompleted && isNowCompleted) {
          fields.push('completed_at = CURRENT_TIMESTAMP');
        } else if (wasCompleted && !isNowCompleted) {
          // Clear completed_at when un-completing a task
          fields.push('completed_at = NULL');
        }
        // If status doesn't change completion state, leave completed_at unchanged
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
      // For repeating tasks, completed_at is the last completion
      if (task.repeat_interval && task.completed_at) {
        task.last_completed = task.completed_at;
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
    // Skip sync-conflict files
    if (filePath.includes('sync-conflict')) {
      return 0;
    }
    
    // Skip plan files - these are daily reviews and shouldn't add tasks to the database
    // Tasks in plan files are already in the database from their original sources
    if (filePath.startsWith('vault/plans/')) {
      return 0;
    }
    
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const updates = [];
    const seenTaskIds = new Set();
    
    // Get file modification time
    const stats = await fs.stat(filePath);
    const fileModTime = stats.mtime;

    // Check if this is a review file and extract the date
    let reviewDate = null;
    if (filePath.startsWith('vault/plans/')) {
      // Match format like 2025_Q3_09_W36_02.md
      const dateMatch = filePath.match(/(\d{4})_Q\d+_(\d{2})_W\d{2}_(\d{2})\.md$/);  
      if (dateMatch) {
        // Convert to ISO format: YYYY-MM-DD
        const [_, year, month, day] = dateMatch;
        reviewDate = `${year}-${month}-${day}`;
      }
    }
    
    // Check if this is a topic file and extract the topic
    let topicName = null;
    if (filePath.startsWith('vault/topics/')) {
      // Read the first line to get the topic name
      const firstLine = lines.find(line => line.startsWith('# '));
      if (firstLine) {
        topicName = firstLine.replace(/^#\s+/, '').trim();
      }
    }

    // Sync project file first if it's a project
    let projectId = null;
    if (filePath.startsWith('vault/projects/')) {
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
      // Also match "none" as a special task-id for template/routine tasks
      // Accept both 32-char (legacy) and 36-char (with dashes) hex formats
      const taskMatch = line.match(/^- \[([ x])\] (.+?)(?:<![-—]+ task-id: ([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|none) [-—]+>)?$/);
      
      if (taskMatch) {
        const isCompleted = taskMatch[1] === 'x';
        let title = taskMatch[2].trim();
        
        // Clean up any HTML comment remnants that might have leaked into the title
        // This can happen if there were malformed duplicate task-id comments
        title = title.replace(/<!--.*$/g, '').trim();
        title = title.replace(/<!-.*$/g, '').trim();
        title = title.replace(/\s+task-id:.*$/g, '').trim();
        
        // CRITICAL: Remove status emojis from the title to prevent accumulation
        // These should only be in markdown display, never in the database title
        const statusEmojis = [
          '🎭', '🗂️', '1️⃣', '2️⃣', '3️⃣', '📋', '✅', '⏳', '🔄', '❌', '✉️', 'Next'
        ];
        
        // Keep removing status prefixes until none are left
        let previousTitle;
        do {
          previousTitle = title;
          for (const emoji of statusEmojis) {
            if (title.startsWith(emoji + ' ')) {
              title = title.substring(emoji.length + 1).trim();
            } else if (title.startsWith(emoji)) {
              title = title.substring(emoji.length).trim();
            }
          }
        } while (title !== previousTitle);
        
        const existingId = taskMatch[3];

        // Skip tasks marked with task-id: none (template/routine tasks)
        if (existingId === 'none') {
          continue;
        }

        // Remove any topic tags from the title (e.g., [Health], [Programming])
        // These are stored separately in the database and shouldn't be in the title
        title = title.replace(/\s*\[[^\]]+\]/g, '').trim();

        // Parse Obsidian Tasks plugin date syntax
        let scheduledDate = null;
        let dueDate = null;

        // Look for scheduled date (⏳ YYYY-MM-DD)
        const scheduledMatch = title.match(/⏳\s*(\d{4}-\d{2}-\d{2})/);
        if (scheduledMatch) {
          scheduledDate = scheduledMatch[1];
          // Remove from title
          title = title.replace(/\s*⏳\s*\d{4}-\d{2}-\d{2}/g, '').trim();
        }

        // Look for due date (📅 YYYY-MM-DD)
        const dueMatch = title.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
        if (dueMatch) {
          dueDate = dueMatch[1];
          // Remove from title
          title = title.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, '').trim();
        }

        // Parse priority (🔺 high, 🔼 medium, ⏫ low)
        let priority = null;
        if (title.includes('🔺')) {
          priority = 'high';
          title = title.replace(/\s*🔺/g, '').trim();
        } else if (title.includes('🔼')) {
          priority = 'medium';
          title = title.replace(/\s*🔼/g, '').trim();
        } else if (title.includes('⏫')) {
          priority = 'low';
          title = title.replace(/\s*⏫/g, '').trim();
        }

        // Parse recurrence (🔁 every day/week/month/year) and convert to days
        let repeatInterval = null;
        const recurrenceMatch = title.match(/🔁\s*(every\s+(?:day|week|month|year|\d+\s*(?:days?|weeks?|months?|years?)))/i);
        if (recurrenceMatch) {
          const recurrenceText = recurrenceMatch[1].toLowerCase();

          // Convert to days
          if (recurrenceText === 'every day') {
            repeatInterval = 1;
          } else if (recurrenceText === 'every week') {
            repeatInterval = 7;
          } else if (recurrenceText === 'every month') {
            repeatInterval = 30; // Approximate
          } else if (recurrenceText === 'every year') {
            repeatInterval = 365;
          } else {
            // Parse numeric intervals like "every 3 days" or "every 2 weeks"
            const numMatch = recurrenceText.match(/every\s+(\d+)\s*(days?|weeks?|months?|years?)/);
            if (numMatch) {
              const num = parseInt(numMatch[1]);
              const unit = numMatch[2];
              if (unit.startsWith('day')) {
                repeatInterval = num;
              } else if (unit.startsWith('week')) {
                repeatInterval = num * 7;
              } else if (unit.startsWith('month')) {
                repeatInterval = num * 30; // Approximate
              } else if (unit.startsWith('year')) {
                repeatInterval = num * 365;
              }
            }
          }

          // Remove from title
          title = title.replace(/\s*🔁\s*every\s+(?:day|week|month|year|\d+\s*(?:days?|weeks?|months?|years?))/gi, '').trim();
        }

        // Use scheduled date or due date as the do_date (prefer scheduled)
        let extractedDate = scheduledDate || dueDate;

        // Also support legacy date tags if no Obsidian Tasks dates found
        if (!extractedDate) {
          const dateTags = this.dateParser.extractDateTags(title);
          if (dateTags.length > 0) {
            // Use the first date tag found
            extractedDate = dateTags[0].parsed;
            // Remove all date topics from the title
            title = this.dateParser.removeTagsFromText(title, dateTags);
          }
        }

        let taskId;
        if (existingId) {
          // Task has an ID - either update existing or create with that ID
          taskId = existingId;
          const task = this.getTask(taskId);
          if (task) {
            // Task exists in database - check if we need to update it
            // Use last_modified if available, otherwise fall back to updated_at
            const taskUpdateTime = task.last_modified ? new Date(task.last_modified) : 
                                  (task.updated_at ? new Date(task.updated_at) : new Date(0));
            const markdownIsNewer = fileModTime > taskUpdateTime;
            
            // For generated files in vault/tasks/, we need special handling:
            // Only sync checkbox changes if the file is newer AND checkbox state changed
            // This allows manual checking/unchecking while preventing re-applying old states
            const isGeneratedFile = filePath === 'vault/tasks-today.md' ||
                                  filePath === 'vault/tasks/tasks.md' ||
                                  filePath === 'vault/tasks-stages.md';
            
            // Check if this is a checkbox state change
            const taskIsCompleted = task.status === '✅ Done';
            const checkboxChanged = isCompleted !== taskIsCompleted;
            
            // For generated files: only sync if file is newer AND checkbox changed
            // For source files: always sync if file is newer
            const shouldSync = isGeneratedFile ? 
              (markdownIsNewer && checkboxChanged) : 
              markdownIsNewer;
            
            if (shouldSync) {
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
              if (repeatInterval !== null && task.repeat_interval !== repeatInterval) updates.repeat_interval = repeatInterval;
              
              // DISABLED: Don't auto-assign dates from plan files
              // Plan files are for organizing/reviewing tasks, not setting due dates
              // if (reviewDate && !isCompleted && !task.do_date) {
              //   updates.do_date = reviewDate;
              // }
              
              if (Object.keys(updates).length > 0) {
                this.updateTask(taskId, updates);
                // Log checkbox state changes for debugging
                if (updates.status) {
                  console.log(`  • Task "${task.title.substring(0, 30)}..." status: ${task.status} → ${updates.status}`);
                }
              }
            }
          } else {
            // Task has ID but doesn't exist in database - create it with that ID
            console.log(`  • Creating missing task: ${title.substring(0, 50)}... (ID: ${taskId.substring(0, 8)}...)`);
            
            const taskData = {
              id: taskId,  // Use the existing ID
              title,
              status: isCompleted ? '✅ Done' : '🗂️ To File',
              project_id: projectId,
              repeat_interval: repeatInterval
            };
            
            // Set do_date from extracted date tag only (not from plan file names)
            if (extractedDate) {
              taskData.do_date = extractedDate;
            }
            // DISABLED: Don't auto-assign dates from plan file names
            // else if (reviewDate && !isCompleted) {
            //   taskData.do_date = reviewDate;
            // }
            
            // Insert with specific ID
            this.db.prepare(`
              INSERT INTO tasks (id, title, status, project_id, do_date, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            `).run(taskId, taskData.title, taskData.status, taskData.project_id, taskData.do_date);
            
            // If this is a topic file, automatically assign the topic to the new task
            if (topicName) {
              this.addTopicToTask(taskId, topicName);
            }
          }
        } else {
          // No existing ID - create new task
          const taskData = {
            title,
            status: isCompleted ? '✅ Done' : '🗂️ To File',
            project_id: projectId,
            repeat_interval: repeatInterval
          };
          
          // Set do_date from extracted date tag only (not from plan file names)
          if (extractedDate) {
            taskData.do_date = extractedDate;
          }
          // DISABLED: Don't auto-assign dates from plan file names
          // Plan files are for organizing/reviewing tasks, not setting due dates
          
          taskId = this.createTask(taskData);
          
          // If this is a topic file, automatically assign the topic to the new task
          if (topicName) {
            this.addTopicToTask(taskId, topicName);
          }
          
          // Add task ID to the line (strip any corrupted comments first)
          // Match both 32-char and 36-char formats
          const cleanLine = line.replace(/<![-—]+ task-id: ([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) [-—]+>/g, '');
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
        // Task was removed from markdown - just remove the sync association
        // Do NOT mark as done - the task may have been moved to another file
        this.db.prepare('DELETE FROM markdown_sync WHERE file_path = ? AND task_id = ?')
          .run(filePath, task.id);
      }
    }

    return updates.length;
  }

  // Generate all active tasks file
  // Note: Checkbox syncing is handled separately, not during generation
  async generateAllTasksFile(outputPath = 'vault/tasks/tasks.md') {

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
    
    // Helper function to parse malformed date formats
    const parseMalformedDate = (dateStr) => {
      // Handle formats like "2025_Q3_08_W33_17" or "2025-Q3-08-18" or "2025_Q3_08_W34_00"
      // Extract year, month, and day parts
      const match = dateStr.match(/^(\d{4})[_-]Q(\d)[_-](\d{2})[_-](?:W\d+[_-])?(\d{2})$/);
      if (match) {
        const [_, year, quarter, month, day] = match;
        // If day is 00, it represents a week or period, not a specific date
        // Use the first day of the week (calculate from week number if present)
        if (day === '00') {
          // Extract week number if present
          const weekMatch = dateStr.match(/W(\d+)/);
          if (weekMatch) {
            const weekNum = parseInt(weekMatch[1]);
            // Calculate the first day of the ISO week
            const jan1 = new Date(`${year}-01-01T00:00:00`);
            const jan1Day = jan1.getDay() || 7; // Convert Sunday (0) to 7
            const daysToAdd = (weekNum - 1) * 7 + (8 - jan1Day); // ISO week starts on Monday
            const weekStart = new Date(jan1);
            weekStart.setDate(jan1.getDate() + daysToAdd);
            return weekStart;
          }
          // If no week number or can't calculate, use first day of month
          return new Date(`${year}-${month.padStart(2, '0')}-01T00:00:00`);
        }
        return new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00`);
      }
      
      // Try standard date parsing
      const date = new Date(dateStr + 'T00:00:00');
      return date;
    };
    
    // Helper function to format date header
    const formatDateHeader = (dateStr) => {
      const date = parseMalformedDate(dateStr);
      
      // Check if date is valid
      if (isNaN(date.getTime())) {
        // Return the raw date string if we can't parse it
        return `### ${dateStr}`;
      }
      
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
        // Sort tasks by status priority
        const sortedTasks = tasksByDate[date].sort((a, b) => 
          this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
        );
        
        for (const task of sortedTasks) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          const topics = this.getTaskTopics(task.id);
          const topicStr = this.formatTopicsAsEmojis(topics);
          const statusIcon = this.getStatusIcon(task.status);
          const iconPrefix = statusIcon ? `${statusIcon} ` : '';
          lines.push(`- [${checkbox}] ${iconPrefix}${task.title}${topicStr} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
      
      // Add tasks with no date
      if (noDateTasks.length > 0) {
        lines.push('### No Date Set');
        lines.push('');
        // Sort tasks by status priority
        const sortedNoDateTasks = noDateTasks.sort((a, b) => 
          this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
        );
        
        for (const task of sortedNoDateTasks) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          const topics = this.getTaskTopics(task.id);
          const topicStr = this.formatTopicsAsEmojis(topics);
          const statusIcon = this.getStatusIcon(task.status);
          const iconPrefix = statusIcon ? `${statusIcon} ` : '';
          lines.push(`- [${checkbox}] ${iconPrefix}${task.title}${topicStr} <!-- task-id: ${task.id} -->`);
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
        // Sort tasks by status priority
        const sortedTasks = tasksByDate[date].sort((a, b) => 
          this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
        );
        
        for (const task of sortedTasks) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          const topics = this.getTaskTopics(task.id);
          const topicStr = this.formatTopicsAsEmojis(topics);
          const statusIcon = this.getStatusIcon(task.status);
          const iconPrefix = statusIcon ? `${statusIcon} ` : '';
          lines.push(`- [${checkbox}] ${iconPrefix}${task.title}${topicStr} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
      
      // Add tasks with no date
      if (noDateTasks.length > 0) {
        lines.push('### No Date Set');
        lines.push('');
        // Sort tasks by status priority
        const sortedNoDateTasks = noDateTasks.sort((a, b) => 
          this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
        );
        
        for (const task of sortedNoDateTasks) {
          const checkbox = task.status === '✅ Done' ? 'x' : ' ';
          const topics = this.getTaskTopics(task.id);
          const topicStr = this.formatTopicsAsEmojis(topics);
          const statusIcon = this.getStatusIcon(task.status);
          const iconPrefix = statusIcon ? `${statusIcon} ` : '';
          lines.push(`- [${checkbox}] ${iconPrefix}${task.title}${topicStr} <!-- task-id: ${task.id} -->`);
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
  async generateTodayFile(outputPath = 'vault/tasks-today.md') {
    // Check if file was recently modified (within last 30 seconds)
    // This prevents overwriting manual edits that just happened
    try {
      const stats = await fs.stat(outputPath);
      const timeSinceModified = Date.now() - stats.mtime.getTime();
      if (timeSinceModified < 30000) {
        // File was recently edited, check if we should skip regeneration
        // Only skip if the file has uncaptured manual changes
        const content = await fs.readFile(outputPath, 'utf-8');
        const hasUncheckedTasks = content.includes('- [ ]');
        const hasCheckedTasks = content.includes('- [x]');
        
        if (hasCheckedTasks && timeSinceModified < 5000) {
          // User just checked tasks, give sync time to capture them
          console.log('  • Delaying today.md regeneration (capturing recent checkbox changes)');
          return 0;
        }
      }
    } catch (err) {
      // File doesn't exist yet, continue with generation
    }

    // Get today's date
    const today = new Date().toISOString().split('T')[0];
    
    // Get overdue tasks (before today, not done)
    const overdueTasks = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE do_date < ?
        AND do_date IS NOT NULL
        AND status != '✅ Done'
      ORDER BY do_date ASC, status ASC
    `).all(today).map(task => ({
      ...task,
      topics: this.getTaskTopics(task.id)
    }));
    
    // Get active tasks for today (not done, not overdue)
    const activeTasks = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE do_date = ?
        AND status != '✅ Done'
      ORDER BY do_date ASC, status ASC
    `).all(today).map(task => ({
      ...task,
      topics: this.getTaskTopics(task.id)
    }));
    
    // Don't include priority tasks without dates - today.md is only for tasks due today or overdue
    const priorityTasksWithoutDates = [];
    
    // Get tasks completed today using completed_at from tasks table
    // IMPORTANT: Only show tasks that have BOTH status='✅ Done' AND completed_at is today
    // This prevents showing tasks marked done without a completion date
    const completedTasksQuery = this.db.prepare(`
      SELECT * 
      FROM tasks
      WHERE DATE(completed_at) = DATE(?)
        AND status = '✅ Done'
        AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
    `);
    
    const completedTasks = completedTasksQuery.all(today).map(task => ({
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

    // Add overdue section if there are overdue tasks
    if (overdueTasks.length > 0) {
      lines.push('## ⚠️ Overdue', '');
      
      // Group overdue tasks by date for better readability
      const overdueByDate = {};
      for (const task of overdueTasks) {
        if (!overdueByDate[task.do_date]) {
          overdueByDate[task.do_date] = [];
        }
        overdueByDate[task.do_date].push(task);
      }
      
      // Sort dates in ascending order
      const sortedDates = Object.keys(overdueByDate).sort();
      
      for (const date of sortedDates) {
        // Validate date before processing
        if (!date || date === 'null' || date === 'undefined' || date === '') {
          console.warn(`Skipping invalid date: '${date}'`);
          continue;
        }
        
        // Format date nicely
        const dateObj = new Date(date + 'T00:00:00');
        
        // Check if date is valid
        if (isNaN(dateObj.getTime())) {
          console.warn(`Skipping malformed date: '${date}'`);
          continue;
        }
        
        const daysDiff = Math.floor((new Date(today) - dateObj) / (1000 * 60 * 60 * 24));
        const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const daysAgoStr = daysDiff === 1 ? '1 day ago' : `${daysDiff} days ago`;
        
        lines.push(`### ${dateStr} (${daysAgoStr})`, '');
        
        // Sort tasks by status priority
        const sortedTasks = overdueByDate[date].sort((a, b) => 
          this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
        );
        
        for (const task of sortedTasks) {
          const topics = this.formatTopicsAsEmojis(task.topics);
          const statusIcon = this.getStatusIcon(task.status);
          const iconPrefix = statusIcon ? `${statusIcon} ` : '';
          lines.push(`- [ ] ${iconPrefix}${task.title}${topics} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
    }

    // Group tasks by status (combine today's tasks and priority tasks without dates)
    const tasksByStatus = {};
    const allActiveTasks = [...activeTasks, ...priorityTasksWithoutDates];
    for (const task of allActiveTasks) {
      const status = task.status || '🗂️ To File';
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
      // Sort tasks by status priority
      const sortedTasks = tasksByStatus[status].sort((a, b) => 
        this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
      );
      
      for (const task of sortedTasks) {
        const topics = this.formatTopicsAsEmojis(task.topics);
        const statusIcon = this.getStatusIcon(task.status);
        const iconPrefix = statusIcon ? `${statusIcon} ` : '';
        lines.push(`- [ ] ${iconPrefix}${task.title}${topics} <!-- task-id: ${task.id} -->`);
      }
      lines.push('');
    }
    
    // Add completed tasks in a collapsible Done section
    if (completedTasks.length > 0) {
      lines.push('<details>');
      lines.push(`<summary><strong>✅ Done Today</strong> (${completedTasks.length} tasks completed)</summary>`);
      lines.push('');
      for (const task of completedTasks) {
        const topics = this.formatTopicsAsEmojis(task.topics);
        lines.push(`- [x] ${task.title}${topics} <!-- task-id: ${task.id} -->`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    // Add upcoming tasks section (next 14 days)
    const twoWeeksFromNow = new Date();
    twoWeeksFromNow.setDate(twoWeeksFromNow.getDate() + 14);
    const twoWeeksDate = twoWeeksFromNow.toISOString().split('T')[0];
    
    const upcomingTasks = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE do_date > ?
        AND do_date <= ?
        AND do_date IS NOT NULL
        AND status != '✅ Done'
      ORDER BY do_date ASC, status ASC
    `).all(today, twoWeeksDate).map(task => ({
      ...task,
      topics: this.getTaskTopics(task.id)
    }));
    
    // Add upcoming tasks in a collapsible section
    if (upcomingTasks.length > 0) {
      lines.push('<details>');
      lines.push(`<summary><strong>📅 Upcoming</strong> (${upcomingTasks.length} tasks in next 2 weeks)</summary>`);
      lines.push('');
      
      // Group upcoming tasks by date
      const upcomingByDate = {};
      for (const task of upcomingTasks) {
        if (!upcomingByDate[task.do_date]) {
          upcomingByDate[task.do_date] = [];
        }
        upcomingByDate[task.do_date].push(task);
      }
      
      // Sort dates
      const sortedUpcomingDates = Object.keys(upcomingByDate).sort();
      
      for (const date of sortedUpcomingDates) {
        // Format date nicely
        const dateObj = new Date(date + 'T00:00:00');
        const daysFromNow = Math.ceil((dateObj - new Date()) / (1000 * 60 * 60 * 24));
        const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const daysStr = daysFromNow === 1 ? 'tomorrow' : `in ${daysFromNow} days`;
        
        lines.push(`### ${dateStr} (${daysStr})`, '');
        
        // Sort tasks by status priority
        const sortedTasks = upcomingByDate[date].sort((a, b) => 
          this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
        );
        
        for (const task of sortedTasks) {
          const topics = this.formatTopicsAsEmojis(task.topics);
          const statusIcon = this.getStatusIcon(task.status);
          const iconPrefix = statusIcon ? `${statusIcon} ` : '';
          lines.push(`- [ ] ${iconPrefix}${task.title}${topics} <!-- task-id: ${task.id} -->`);
        }
        lines.push('');
      }
      
      lines.push('</details>');
      lines.push('');
    }

    await fs.writeFile(outputPath, lines.join('\n'));
    return activeTasks.length + overdueTasks.length + completedTasks.length;
  }

  // Handle repeating tasks
  processRepeatingTasks() {
    const today = new Date().toISOString().split('T')[0];
    const repeatingTasks = this.db.prepare(`
      SELECT *, completed_at as last_completed
      FROM tasks
      WHERE repeat_interval IS NOT NULL 
        AND status = '✅ Done'
    `).all();

    let created = 0;
    for (const task of repeatingTasks) {
      // Calculate next date based on last completion
      const nextDate = this.calculateNextDateFromInterval(task.completed_at, task.repeat_interval);
      
      // Check if we already have an incomplete instance of this recurring task
      // Look for tasks with the same title that are not done
      // Don't check repeat_interval as the new instance might not have it set yet
      const existingIncomplete = this.db.prepare(`
        SELECT id, do_date FROM tasks 
        WHERE title = ? 
          AND status != '✅ Done'
          AND id != ?
      `).get(task.title, task.id);
      
      if (!existingIncomplete) {
        // Create new task instance for the calculated future date
        // This task should be created regardless of whether nextDate is in the future
        this.createTask({
          title: task.title,
          description: task.description,
          do_date: nextDate,  // This will be the future date (e.g., 7 days from completion)
          status: '🗂️ To File',
          stage: null,
          project_id: task.project_id,
          repeat_interval: task.repeat_interval,
          topics: this.getTaskTopics(task.id)
        });
        created++;

        // Update the original task's repeat_next_date
        this.db.prepare('UPDATE tasks SET repeat_next_date = ? WHERE id = ?')
          .run(nextDate, task.id);
      } else if (existingIncomplete.do_date !== nextDate) {
        // Update the existing incomplete task's date if it's different
        // This handles the case where the task was created with the wrong date
        this.db.prepare('UPDATE tasks SET do_date = ? WHERE id = ?')
          .run(nextDate, existingIncomplete.id);
      }
    }

    return created;
  }

  // Generate topic files with Obsidian Tasks query blocks
  async generateTopicFiles() {
    const fs = await import('fs').then(m => m.promises);
    const path = await import('path');

    // Get all task lines with topic tags from the markdown_tasks cache
    const tasksWithTopics = this.db.prepare(`
      SELECT DISTINCT line_text
      FROM markdown_tasks
      WHERE line_text LIKE '%#topic/%'
        AND is_done = 0
    `).all();

    // Extract unique topics from the task lines
    const topicSet = new Set();
    const topicRegex = /#topic\/([a-zA-Z0-9_-]+)/g;

    for (const task of tasksWithTopics) {
      const matches = task.line_text.matchAll(topicRegex);
      for (const match of matches) {
        topicSet.add(match[1]);
      }
    }

    const topics = Array.from(topicSet).sort();

    if (topics.length === 0) {
      return 0;
    }

    // Ensure topics directory exists
    const topicsDir = 'vault/topics';
    try {
      await fs.mkdir(topicsDir, { recursive: true });
    } catch (e) {
      // Directory may already exist
    }

    let generatedCount = 0;

    for (const topicTag of topics) {
      // topicTag is already in the format we need (e.g., "health", "ogm", etc.)
      const filename = topicTag;

      // Convert to readable name for the title (e.g., "health" -> "Health", "ogm" -> "Ogm")
      const topicName = topicTag
        .split(/[-_]/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      const filePath = path.join(topicsDir, `${filename}.md`);

      // Create file content with Obsidian Tasks query block
      const lines = [];
      lines.push(`# ${topicName}`);
      lines.push('');
      lines.push('```tasks');
      lines.push(`filter by function task.tags.join(',').includes('#topic/${filename}')`);
      lines.push('```');
      
      // Remove trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      
      await fs.writeFile(filePath, lines.join('\n'));
      generatedCount++;
    }

    // Clean up topic files that no longer have any tasks
    try {
      const existingTopicFiles = await fs.readdir(topicsDir);
      for (const file of existingTopicFiles) {
        if (file.endsWith('.md')) {
          const topicFromFile = file.slice(0, -3); // Remove .md extension
          if (!topics.includes(topicFromFile)) {
            // This topic no longer has any active tasks, remove the file
            await fs.unlink(path.join(topicsDir, file));
            console.log(`  Removed obsolete topic file: ${file}`);
          }
        }
      }
    } catch (e) {
      // Directory might not exist or other error
      console.error('Error cleaning up topic files:', e.message);
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
      case '🗂️ To File':
        return 2; // Low priority
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

  async generateStagesFile(outputPath = 'vault/tasks/stages.md') {
    // Get all active tasks (not Done) grouped by stage
    const frontStageTasks = this.db.prepare(`
      SELECT t.*, p.name as project_name
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.stage = 'Front Stage' 
        AND t.status != '✅ Done'
      ORDER BY p.name, t.do_date ASC, t.status ASC
    `).all();

    const backStageTasks = this.db.prepare(`
      SELECT t.*, p.name as project_name
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.stage = 'Back Stage' 
        AND t.status != '✅ Done'
      ORDER BY p.name, t.do_date ASC, t.status ASC
    `).all();

    const offStageTasks = this.db.prepare(`
      SELECT t.*, p.name as project_name
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.stage = 'Off Stage' 
        AND t.status != '✅ Done'
      ORDER BY p.name, t.do_date ASC, t.status ASC
    `).all();

    // Generate markdown content
    let content = '# Tasks by Stage\n\n';
    content += '*This file organizes all open tasks by their stage (Front, Back, or Off). Generated automatically.*\n\n';
    
    // Use Eastern timezone for timestamp
    const now = new Date();
    const easternTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    }).format(now);
    
    content += `*Generated: ${easternTime}*\n\n`;

    // Front Stage section
    content += '<details>\n';
    content += `<summary><strong>🎭 Front Stage</strong> (${frontStageTasks.length} tasks) - Tasks involving interaction with other people</summary>\n\n`;
    content += '*Meetings, calls, emails, customer support, presentations, social activities*\n\n';
    
    if (frontStageTasks.length > 0) {
      const projectGroups = {};
      for (const task of frontStageTasks) {
        const projectName = task.project_name || 'General Tasks';
        if (!projectGroups[projectName]) {
          projectGroups[projectName] = [];
        }
        projectGroups[projectName].push(task);
      }
      
      for (const [projectName, tasks] of Object.entries(projectGroups)) {
        content += `### ${projectName}\n\n`;
        // Sort tasks by status priority
        const sortedTasks = tasks.sort((a, b) => 
          this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
        );
        
        for (const task of sortedTasks) {
          const checkbox = '- [ ]';
          const taskId = task.markdown_id || task.id;
          const statusIcon = this.getStatusIcon(task.status);
          const iconPrefix = statusIcon ? `${statusIcon} ` : '';
          content += `${checkbox} ${iconPrefix}${task.title} <!-- task-id: ${taskId} -->\n`;
        }
        content += '\n';
      }
    } else {
      content += '*No tasks in this stage*\n\n';
    }
    
    content += '</details>\n\n';

    // Back Stage section
    content += '<details>\n';
    content += `<summary><strong>🔧 Back Stage</strong> (${backStageTasks.length} tasks) - Maintenance and behind-the-scenes work</summary>\n\n`;
    content += '*Organizing, cleaning, fixing bugs, paying bills, admin, planning, setup*\n\n';
    
    if (backStageTasks.length > 0) {
      const projectGroups = {};
      for (const task of backStageTasks) {
        const projectName = task.project_name || 'General Tasks';
        if (!projectGroups[projectName]) {
          projectGroups[projectName] = [];
        }
        projectGroups[projectName].push(task);
      }
      
      for (const [projectName, tasks] of Object.entries(projectGroups)) {
        content += `### ${projectName}\n\n`;
        // Sort tasks by status priority
        const sortedTasks = tasks.sort((a, b) => 
          this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
        );
        
        for (const task of sortedTasks) {
          const checkbox = '- [ ]';
          const taskId = task.markdown_id || task.id;
          const statusIcon = this.getStatusIcon(task.status);
          const iconPrefix = statusIcon ? `${statusIcon} ` : '';
          content += `${checkbox} ${iconPrefix}${task.title} <!-- task-id: ${taskId} -->\n`;
        }
        content += '\n';
      }
    } else {
      content += '*No tasks in this stage*\n\n';
    }
    
    content += '</details>\n\n';

    // Off Stage section
    content += '<details>\n';
    content += `<summary><strong>🌟 Off Stage</strong> (${offStageTasks.length} tasks) - Personal time and self-care</summary>\n\n`;
    content += '*Reading, exercise, hobbies, relaxation, learning, health*\n\n';
    
    if (offStageTasks.length > 0) {
      const projectGroups = {};
      for (const task of offStageTasks) {
        const projectName = task.project_name || 'General Tasks';
        if (!projectGroups[projectName]) {
          projectGroups[projectName] = [];
        }
        projectGroups[projectName].push(task);
      }
      
      for (const [projectName, tasks] of Object.entries(projectGroups)) {
        content += `### ${projectName}\n\n`;
        // Sort tasks by status priority
        const sortedTasks = tasks.sort((a, b) => 
          this.getStatusOrder(a.status) - this.getStatusOrder(b.status)
        );
        
        for (const task of sortedTasks) {
          const checkbox = '- [ ]';
          const taskId = task.markdown_id || task.id;
          const statusIcon = this.getStatusIcon(task.status);
          const iconPrefix = statusIcon ? `${statusIcon} ` : '';
          content += `${checkbox} ${iconPrefix}${task.title} <!-- task-id: ${taskId} -->\n`;
        }
        content += '\n';
      }
    } else {
      content += '*No tasks in this stage*\n\n';
    }
    
    content += '</details>\n';

    // Write to file
    await fs.writeFile(outputPath, content, 'utf-8');
    
    return frontStageTasks.length + backStageTasks.length + offStageTasks.length;
  }

  /**
   * Get the status icon for a task
   */
  getStatusIcon(status) {
    if (!status) return '';
    // Extract just the icon from statuses like "1️⃣  1st Priority"
    const iconMatch = status.match(/^([^ ]+)/);
    return iconMatch ? iconMatch[1] : '';
  }

  /**
   * Get sort order for status (lower numbers = higher priority)
   */
  getStatusOrder(status) {
    const order = {
      '1️⃣  1st Priority': 1,
      '2️⃣  2nd Priority': 2,
      '3️⃣  3rd Priority': 3,
      '🤔 Waiting': 4,
      '⏸️  Paused': 5,
      '🗂️  To File': 6,
      '✅ Done': 7
    };
    return order[status] || 99;
  }

  async close() {
    await this.db.close();
  }
}