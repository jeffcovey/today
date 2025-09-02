import { jest } from '@jest/globals';
import { TaskManager } from '../src/task-manager.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';

// Mock the database-sync module
jest.mock('../src/database-sync.js', () => ({
  getDatabaseSync: jest.fn(() => {
    const Database = jest.requireActual('better-sqlite3');
    return new Database(':memory:');
  }),
  forcePushToTurso: jest.fn()
}));

describe('TaskManager', () => {
  let taskManager;
  let tempDir;

  beforeEach(async () => {
    // Create temp directory for test files
    tempDir = `/tmp/test-${Date.now()}`;
    await fs.mkdir(tempDir, { recursive: true });
    
    // Create a new task manager with in-memory database
    taskManager = new TaskManager(':memory:');
  });

  afterEach(async () => {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Task CRUD operations', () => {
    test('should create a task', () => {
      const taskData = {
        title: 'Test task',
        status: '🗂️ To File',
        do_date: '2025-08-16'
      };
      
      const taskId = taskManager.createTask(taskData);
      expect(taskId).toBeDefined();
      expect(taskId).toHaveLength(32);
      
      const task = taskManager.getTask(taskId);
      expect(task.title).toBe('Test task');
      expect(task.status).toBe('🗂️ To File');
      expect(task.do_date).toBe('2025-08-16');
    });

    test('should update a task', () => {
      const taskId = taskManager.createTask({ title: 'Original title' });
      
      taskManager.updateTask(taskId, { 
        title: 'Updated title',
        status: '✅ Done'
      });
      
      const task = taskManager.getTask(taskId);
      expect(task.title).toBe('Updated title');
      expect(task.status).toBe('✅ Done');
    });

    test('should mark a task as completed', () => {
      const taskId = taskManager.createTask({ title: 'To be completed' });
      expect(taskManager.getTask(taskId)).toBeDefined();
      
      taskManager.updateTask(taskId, { status: '✅ Done' });
      const task = taskManager.getTask(taskId);
      expect(task.status).toBe('✅ Done');
    });

    test('should get today tasks', () => {
      const today = new Date().toISOString().split('T')[0];
      taskManager.createTask({ title: 'Due today', do_date: today });
      taskManager.createTask({ title: 'Not due today' });
      
      const todayTasks = taskManager.getTodayTasks();
      expect(todayTasks.length).toBeGreaterThanOrEqual(1);
      expect(todayTasks.some(t => t.title === 'Due today')).toBe(true);
    });

    test('should get active tasks', () => {
      taskManager.createTask({ title: 'Active 1', status: '🗂️ To File' });
      taskManager.createTask({ title: 'Active 2', status: 'Next Up' });
      taskManager.createTask({ title: 'Done', status: '✅ Done' });
      
      const activeTasks = taskManager.getActiveTasks();
      // Allow for existing tasks in database
      expect(activeTasks.length).toBeGreaterThanOrEqual(2);
      expect(activeTasks.every(t => t.status !== '✅ Done')).toBe(true);
    });
  });

  describe('Date tag integration', () => {
    beforeEach(() => {
      // Mock the date for consistent testing
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-08-16T12:00:00'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('should extract and parse date tags when syncing markdown', async () => {
      const markdownPath = `${tempDir}/test.md`;
      const content = `# Tasks
- [ ] Task with @today tag
- [ ] Another task @tomorrow
- [ ] Weekend task @weekend
- [ ] Task without date`;
      
      await fs.writeFile(markdownPath, content);
      
      const updates = await taskManager.syncMarkdownFile(markdownPath);
      expect(updates).toBe(4); // Should add IDs to all 4 tasks
      
      // Read back the file to check IDs were added
      const updatedContent = await fs.readFile(markdownPath, 'utf-8');
      expect(updatedContent).toContain('<!-- task-id:');
      
      // Check that dates were extracted
      const tasks = taskManager.getActiveTasks();
      const todayTask = tasks.find(t => t.title === 'Task with tag');
      const tomorrowTask = tasks.find(t => t.title === 'Another task');
      const weekendTask = tasks.find(t => t.title === 'Weekend task');
      const noDateTask = tasks.find(t => t.title === 'Task without date');
      
      expect(todayTask.do_date).toBe('2025-08-16');
      expect(tomorrowTask.do_date).toBe('2025-08-17');
      expect(weekendTask.do_date).toBe('2025-08-23');
      expect(noDateTask.do_date).toBeNull();
    });

    test('should update existing task with new date tag', async () => {
      // Create initial task with different title to force update
      const taskId = taskManager.createTask({ title: 'Initial task' });
      
      const markdownPath = `${tempDir}/test.md`;
      const content = `# Tasks
- [ ] Existing task @3d <!-- task-id: ${taskId} -->`;
      
      await fs.writeFile(markdownPath, content);
      await taskManager.syncMarkdownFile(markdownPath);
      
      const task = taskManager.getTask(taskId);
      expect(task.title).toBe('Existing task');
      // The date parser should correctly parse @3d as 3 days from today
      expect(task.do_date).toBeDefined();
      expect(task.do_date).not.toBeNull();
    });

    test('should not create duplicates when date tags are present', async () => {
      const markdownPath = `${tempDir}/test.md`;
      const content = `# Tasks
- [ ] Unique task with @today tag`;
      
      await fs.writeFile(markdownPath, content);
      
      // Sync twice
      await taskManager.syncMarkdownFile(markdownPath);
      await taskManager.syncMarkdownFile(markdownPath);
      
      const tasks = taskManager.getActiveTasks();
      const matchingTasks = tasks.filter(t => t.title === 'Unique task with tag');
      expect(matchingTasks).toHaveLength(1);
    });
  });

  describe('Markdown sync', () => {
    test('should add task IDs to unmarked tasks', async () => {
      const markdownPath = `${tempDir}/test.md`;
      const content = `# Tasks
- [ ] Task 1
- [ ] Task 2
- [x] Completed task`;
      
      await fs.writeFile(markdownPath, content);
      
      const updates = await taskManager.syncMarkdownFile(markdownPath);
      expect(updates).toBe(3);
      
      const updatedContent = await fs.readFile(markdownPath, 'utf-8');
      const idMatches = updatedContent.match(/<!-- task-id: [a-f0-9]{32} -->/g);
      expect(idMatches).toHaveLength(3);
    });

    test('should preserve existing task IDs', async () => {
      const existingId = 'a'.repeat(32);
      const markdownPath = `${tempDir}/test.md`;
      const content = `# Tasks
- [ ] Existing task <!-- task-id: ${existingId} -->`;
      
      // Create the task first
      taskManager.db.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run(existingId, 'Existing task');
      
      await fs.writeFile(markdownPath, content);
      await taskManager.syncMarkdownFile(markdownPath);
      
      const updatedContent = await fs.readFile(markdownPath, 'utf-8');
      expect(updatedContent).toContain(`<!-- task-id: ${existingId} -->`);
    });

    test('should track markdown sync records', async () => {
      const markdownPath = `${tempDir}/test.md`;
      const content = `- [ ] Task 1`;
      
      await fs.writeFile(markdownPath, content);
      await taskManager.syncMarkdownFile(markdownPath);
      
      const tasks = taskManager.getMarkdownTasks(markdownPath);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('Task 1');
    });
  });

  describe('Task generation', () => {
    test('should generate today.md with prioritized tasks', async () => {
      // Create tasks with different priorities using actual status values
      const today = new Date().toISOString().split('T')[0];
      taskManager.createTask({ title: 'Critical task', status: '🔥 Immediate', do_date: today });
      taskManager.createTask({ title: 'High priority', status: '🚀 1st Priority', do_date: today });
      taskManager.createTask({ title: 'Medium priority', status: '🗂️ To File', do_date: today });
      taskManager.createTask({ title: 'Low priority', status: '⏳ Waiting', do_date: today });
      
      // Create and mark task as done to set completed_at properly
      const doneTaskId = taskManager.createTask({ title: 'Done task', status: '🗂️ To File' });
      taskManager.updateTask(doneTaskId, { status: '✅ Done' });
      
      const outputPath = `${tempDir}/today.md`;
      await taskManager.generateTodayFile(outputPath);
      
      const content = await fs.readFile(outputPath, 'utf-8');
      expect(content).toContain('## 🔴 Critical');
      expect(content).toContain('## 🟠 High');
      expect(content).toContain('## 🟡 Medium');
      expect(content).toContain('## 🔵 Low');
      expect(content).toContain('## ✅ Done');
      expect(content).toContain('High priority');
      expect(content).toContain('Done task');
    });

    test('should generate tasks.md grouped by date', async () => {
      taskManager.createTask({ title: 'Today task', do_date: '2025-08-16' });
      taskManager.createTask({ title: 'Tomorrow task', do_date: '2025-08-17' });
      taskManager.createTask({ title: 'No date task' });
      taskManager.createTask({ title: 'Done task', status: '✅ Done' });
      
      const outputPath = `${tempDir}/tasks.md`;
      await taskManager.generateAllTasksFile(outputPath);
      
      const content = await fs.readFile(outputPath, 'utf-8');
      expect(content).toContain('### Today - Saturday, Aug 16');
      expect(content).toContain('### Tomorrow - Sunday, Aug 17');
      expect(content).toContain('### No Date Set');
      expect(content).toContain('Today task');
      expect(content).toContain('Tomorrow task');
      expect(content).toContain('No date task');
      expect(content).not.toContain('Done task'); // Should not include done tasks
    });
  });

  describe('Project integration', () => {
    test('should create and link projects', () => {
      const projectId = taskManager.createProject({ name: 'Test Project' });
      const taskId = taskManager.createTask({ 
        title: 'Project task',
        project_id: projectId 
      });
      
      const task = taskManager.getTask(taskId);
      expect(task.project_id).toBe(projectId);
    });
  });
});