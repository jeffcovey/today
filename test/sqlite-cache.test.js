import { jest } from '@jest/globals';
import { SQLiteCache } from '../src/sqlite-cache.js';
import fs from 'fs';
import path from 'path';

describe('SQLiteCache', () => {
  let cache;
  const testDatabaseId = 'test-db-123';
  const cacheDir = path.join(process.cwd(), '.notion-cache');
  const testDbPath = path.join(cacheDir, 'notion-cache.db');

  beforeEach(() => {
    // Clean up any existing test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    cache = new SQLiteCache();
  });

  afterEach(() => {
    if (cache) {
      cache.close();
    }
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('Task Cache Operations', () => {
    test('should set and get cached tasks', async () => {
      const tasks = [
        {
          id: 'task-1',
          title: 'Test Task 1',
          properties: { status: 'In Progress' },
          url: 'https://notion.so/task-1',
          created_time: '2024-01-01T00:00:00Z',
          last_edited_time: '2024-01-01T12:00:00Z'
        },
        {
          id: 'task-2',
          title: 'Test Task 2',
          properties: { status: 'Done' },
          url: 'https://notion.so/task-2',
          created_time: '2024-01-01T00:00:00Z',
          last_edited_time: '2024-01-01T12:00:00Z'
        }
      ];
      const lastEditedTime = '2024-01-01T12:00:00Z';
      
      await cache.setCachedTasks(testDatabaseId, tasks, lastEditedTime);
      const retrieved = await cache.getCachedTasks(testDatabaseId);
      
      expect(retrieved).not.toBeNull();
      expect(retrieved.tasks).toHaveLength(2);
      expect(retrieved.tasks[0].title).toBe('Test Task 1');
      expect(retrieved.lastEditedTime).toBe(lastEditedTime);
    });

    test('should return null for non-existent database tasks', async () => {
      const result = await cache.getCachedTasks('non-existent-db');
      expect(result).toBeNull();
    });

    test('should validate task cache correctly', async () => {
      const tasks = [{
        id: 'task-1',
        title: 'Test Task',
        properties: {},
        url: 'https://notion.so/task-1',
        created_time: '2024-01-01T00:00:00Z'
      }];
      const lastEditedTime = '2024-01-01T12:00:00Z';
      
      await cache.setCachedTasks(testDatabaseId, tasks, lastEditedTime);
      
      // Cache should be valid for same timestamp
      const isValid = await cache.isTaskCacheValid(testDatabaseId, lastEditedTime);
      expect(isValid).toBe(true);
      
      // Cache should be invalid for newer timestamp
      const newerTime = '2024-01-01T13:00:00Z';
      const isInvalid = await cache.isTaskCacheValid(testDatabaseId, newerTime);
      expect(isInvalid).toBe(false);
    });
  });

  describe('Project Cache Operations', () => {
    test('should set and get cached projects', async () => {
      const projects = [
        {
          id: 'project-1',
          title: 'Test Project',
          url: 'https://notion.so/project-1',
          created_time: '2024-01-01T00:00:00Z',
          status: 'Active'
        }
      ];
      const lastEditedTime = '2024-01-01T12:00:00Z';
      
      await cache.setCachedProjects(testDatabaseId, projects, lastEditedTime);
      const retrieved = await cache.getCachedProjects(testDatabaseId);
      
      expect(retrieved).not.toBeNull();
      expect(retrieved.projects).toHaveLength(1);
      expect(retrieved.projects[0].title).toBe('Test Project');
    });
  });

  describe('Clear Operations', () => {
    test('should clear all cache', async () => {
      const tasks = [{
        id: 'task-1',
        title: 'Test Task',
        properties: {},
        url: 'https://notion.so/task-1',
        created_time: '2024-01-01T00:00:00Z'
      }];
      
      await cache.setCachedTasks(testDatabaseId, tasks, '2024-01-01T12:00:00Z');
      await cache.clearCache();
      
      const result = await cache.getCachedTasks(testDatabaseId);
      expect(result).toBeNull();
    });

    test('should clear tasks cache for specific database', async () => {
      const tasks = [{
        id: 'task-1',
        title: 'Test Task',
        properties: {},
        url: 'https://notion.so/task-1',
        created_time: '2024-01-01T00:00:00Z'
      }];
      
      await cache.setCachedTasks(testDatabaseId, tasks, '2024-01-01T12:00:00Z');
      await cache.clearTasksCache(testDatabaseId);
      
      const result = await cache.getCachedTasks(testDatabaseId);
      expect(result).toBeNull();
    });
  });

  describe('Database Cache Operations', () => {
    test('should set and get cached databases', async () => {
      const databases = [
        { id: 'db-1', title: 'Tasks', url: 'https://notion.so/db-1' },
        { id: 'db-2', title: 'Projects', url: 'https://notion.so/db-2' }
      ];
      
      await cache.setCachedDatabases(databases);
      const retrieved = await cache.getCachedDatabases();
      
      expect(retrieved).not.toBeNull();
      expect(retrieved).toHaveLength(2);
      expect(retrieved[0].title).toBe('Projects'); // Sorted by title
      expect(retrieved[1].title).toBe('Tasks');
    });
  });
});