import fs from 'fs/promises';
import path from 'path';

export class StatusCache {
  constructor() {
    this.cacheDir = path.join(process.cwd(), '.notion-cache');
    this.cacheFile = path.join(this.cacheDir, 'status-groups.json');
    this.taskCacheFile = path.join(this.cacheDir, 'task-data.json');
    this.projectCacheFile = path.join(this.cacheDir, 'project-data.json');
    this.tagCacheFile = path.join(this.cacheDir, 'tag-data.json');
  }

  async ensureCacheDir() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      // Directory already exists, that's fine
    }
  }

  async getCachedStatusGroups(databaseId) {
    try {
      const cacheData = await fs.readFile(this.cacheFile, 'utf8');
      const cache = JSON.parse(cacheData);
      
      if (cache[databaseId]) {
        return cache[databaseId];
      }
    } catch (error) {
      // Cache file doesn't exist or is invalid
    }
    return null;
  }

  async setCachedStatusGroups(databaseId, statusGroups, lastEditedTime) {
    await this.ensureCacheDir();
    
    let cache = {};
    try {
      const cacheData = await fs.readFile(this.cacheFile, 'utf8');
      cache = JSON.parse(cacheData);
    } catch (error) {
      // Cache file doesn't exist, start fresh
    }

    cache[databaseId] = {
      statusGroups,
      lastEditedTime,
      cachedAt: new Date().toISOString()
    };

    await fs.writeFile(this.cacheFile, JSON.stringify(cache, null, 2));
  }

  async isCacheValid(databaseId, currentLastEditedTime) {
    const cached = await this.getCachedStatusGroups(databaseId);
    if (!cached) return false;

    // Check if the database was modified after our cache
    const cachedTime = new Date(cached.lastEditedTime);
    const currentTime = new Date(currentLastEditedTime);
    
    return currentTime <= cachedTime;
  }

  async getCompleteGroupStatuses(databaseId, notionAPI) {
    try {
      // First get the database to check last_edited_time
      const database = await notionAPI.notion.databases.retrieve({
        database_id: databaseId
      });

      const currentLastEditedTime = database.last_edited_time;

      // Check if we have valid cached data
      if (await this.isCacheValid(databaseId, currentLastEditedTime)) {
        const cached = await this.getCachedStatusGroups(databaseId);
        return cached.statusGroups.completeStatuses;
      }

      // Cache is invalid or doesn't exist, fetch fresh data
      const statusProperty = this.findStatusProperty(database.properties);
      if (!statusProperty) {
        throw new Error('No status property found in database');
      }

      const statusGroups = this.extractStatusGroups(statusProperty);
      
      // Cache the results
      await this.setCachedStatusGroups(databaseId, statusGroups, currentLastEditedTime);
      
      return statusGroups.completeStatuses;
    } catch (error) {
      throw new Error(`Failed to get Complete group statuses: ${error.message}`);
    }
  }

  findStatusProperty(properties) {
    for (const [name, property] of Object.entries(properties)) {
      if (property.type === 'status') {
        return property;
      }
    }
    return null;
  }

  extractStatusGroups(statusProperty) {
    const { options, groups } = statusProperty.status;
    
    // Create a map of option_id to option name
    const optionMap = {};
    options.forEach(option => {
      optionMap[option.id] = option.name;
    });

    // Find the Complete group and get all its status names
    const completeGroup = groups.find(group => 
      group.name.toLowerCase() === 'complete' || 
      group.name.toLowerCase() === 'completed'
    );

    let completeStatuses = [];
    if (completeGroup) {
      completeStatuses = completeGroup.option_ids.map(optionId => 
        optionMap[optionId]
      ).filter(Boolean);
    }

    // Also extract all groups for potential future use
    const allGroups = groups.map(group => ({
      name: group.name,
      color: group.color,
      statuses: group.option_ids.map(optionId => optionMap[optionId]).filter(Boolean)
    }));

    return {
      completeStatuses,
      allGroups,
      options
    };
  }

  async clearCache() {
    const cacheFiles = [this.cacheFile, this.taskCacheFile, this.projectCacheFile, this.tagCacheFile];
    
    for (const file of cacheFiles) {
      try {
        await fs.unlink(file);
      } catch (error) {
        // File doesn't exist, that's fine
      }
    }
  }

  async getCachedTasks(databaseId) {
    try {
      const cacheData = await fs.readFile(this.taskCacheFile, 'utf8');
      const cache = JSON.parse(cacheData);
      
      if (cache[databaseId]) {
        return cache[databaseId];
      }
    } catch (error) {
      // Cache file doesn't exist or is invalid
    }
    return null;
  }

  async setCachedTasks(databaseId, tasks, lastEditedTime) {
    await this.ensureCacheDir();
    
    let cache = {};
    try {
      const cacheData = await fs.readFile(this.taskCacheFile, 'utf8');
      cache = JSON.parse(cacheData);
    } catch (error) {
      // Cache file doesn't exist, start fresh
    }

    cache[databaseId] = {
      tasks,
      lastEditedTime,
      cachedAt: new Date().toISOString()
    };

    await fs.writeFile(this.taskCacheFile, JSON.stringify(cache, null, 2));
  }

  async isTaskCacheValid(databaseId, currentLastEditedTime, checkRecentPages = false) {
    const cached = await this.getCachedTasks(databaseId);
    if (!cached) return false;

    // Check if the database was modified after our cache
    const cachedTime = new Date(cached.lastEditedTime);
    const currentTime = new Date(currentLastEditedTime);
    
    // If database timestamp indicates changes, cache is invalid
    if (currentTime > cachedTime) {
      return false;
    }

    // For relation-sensitive queries, also check if cache is older than 1 hour
    // since relation changes don't update database timestamps
    if (checkRecentPages) {
      const cacheAge = new Date() - new Date(cached.cachedAt);
      const oneHour = 60 * 60 * 1000;
      if (cacheAge > oneHour) {
        return false;
      }
    }
    
    return true;
  }

  async getCachedProjects(databaseId) {
    try {
      const cacheData = await fs.readFile(this.projectCacheFile, 'utf8');
      const cache = JSON.parse(cacheData);
      
      if (cache[databaseId]) {
        return cache[databaseId];
      }
    } catch (error) {
      // Cache file doesn't exist or is invalid
    }
    return null;
  }

  async setCachedProjects(databaseId, projects, lastEditedTime) {
    await this.ensureCacheDir();
    
    let cache = {};
    try {
      const cacheData = await fs.readFile(this.projectCacheFile, 'utf8');
      cache = JSON.parse(cacheData);
    } catch (error) {
      // Cache file doesn't exist, start fresh
    }

    cache[databaseId] = {
      projects,
      lastEditedTime,
      cachedAt: new Date().toISOString()
    };

    await fs.writeFile(this.projectCacheFile, JSON.stringify(cache, null, 2));
  }

  async isProjectCacheValid(databaseId, currentLastEditedTime) {
    const cached = await this.getCachedProjects(databaseId);
    if (!cached) return false;

    // Check if the database was modified after our cache
    const cachedTime = new Date(cached.lastEditedTime);
    const currentTime = new Date(currentLastEditedTime);
    
    return currentTime <= cachedTime;
  }

  async invalidateTaskCache() {
    try {
      await fs.unlink(this.taskCacheFile);
    } catch (error) {
      // File doesn't exist, that's fine
    }
  }

  async updateTasksInCache(databaseId, updatedTasks) {
    try {
      const cached = await this.getCachedTasks(databaseId);
      if (!cached || !cached.tasks) {
        // No cache exists, nothing to update
        return;
      }

      // Create a map of updated tasks by ID for efficient lookup
      const updatedTasksMap = new Map(updatedTasks.map(task => [task.id, task]));

      // Update the cached tasks
      const updatedCachedTasks = cached.tasks.map(cachedTask => {
        const updatedTask = updatedTasksMap.get(cachedTask.id);
        return updatedTask ? { ...cachedTask, ...updatedTask } : cachedTask;
      });

      // Save the updated cache
      await this.setCachedTasks(databaseId, updatedCachedTasks, cached.lastEditedTime);
    } catch (error) {
      // If updating fails, fall back to invalidating the cache
      await this.invalidateTaskCache();
    }
  }

  async invalidateProjectCache() {
    try {
      await fs.unlink(this.projectCacheFile);
    } catch (error) {
      // File doesn't exist, that's fine
    }
  }

  async getCachedTags(databaseId) {
    try {
      const cacheData = await fs.readFile(this.tagCacheFile, 'utf8');
      const cache = JSON.parse(cacheData);
      
      if (cache[databaseId]) {
        return cache[databaseId];
      }
    } catch (error) {
      // Cache file doesn't exist or is invalid
    }
    return null;
  }

  async setCachedTags(databaseId, tags, lastEditedTime) {
    await this.ensureCacheDir();
    
    let cache = {};
    try {
      const cacheData = await fs.readFile(this.tagCacheFile, 'utf8');
      cache = JSON.parse(cacheData);
    } catch (error) {
      // Cache file doesn't exist, start fresh
    }

    cache[databaseId] = {
      tags,
      lastEditedTime,
      cachedAt: new Date().toISOString()
    };

    await fs.writeFile(this.tagCacheFile, JSON.stringify(cache, null, 2));
  }

  async isTagCacheValid(databaseId, currentLastEditedTime) {
    const cached = await this.getCachedTags(databaseId);
    if (!cached) return false;

    // Check if the database was modified after our cache
    const cachedTime = new Date(cached.lastEditedTime);
    const currentTime = new Date(currentLastEditedTime);
    
    return currentTime <= cachedTime;
  }

  async invalidateTagCache() {
    try {
      await fs.unlink(this.tagCacheFile);
    } catch (error) {
      // File doesn't exist, that's fine
    }
  }
}