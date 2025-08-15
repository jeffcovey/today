import path from 'path';
import fs from 'fs';
import { getDatabaseSync } from './database-sync.js';

export class SQLiteCache {
  constructor() {
    this.cacheDir = path.join(process.cwd(), '.data');
    this.dbPath = path.join(this.cacheDir, 'today.db');
    this.db = null;
    this.ensureCacheDir();
    this.initDatabase();
  }

  ensureCacheDir() {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch (error) {
      // Directory already exists, that's fine
    }
  }

  initDatabase() {
    // Use DatabaseSync wrapper for automatic Turso sync
    this.db = getDatabaseSync(this.dbPath);
    
    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_metadata (
        database_id TEXT PRIMARY KEY,
        cache_type TEXT NOT NULL,
        last_edited_time TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_cache (
        id TEXT PRIMARY KEY,
        database_id TEXT NOT NULL,
        title TEXT NOT NULL,
        properties TEXT NOT NULL,
        url TEXT NOT NULL,
        created_time TEXT NOT NULL,
        last_edited_time TEXT,
        cached_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_cache (
        id TEXT PRIMARY KEY,
        database_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        created_time TEXT NOT NULL,
        status TEXT,
        cached_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tag_cache (
        id TEXT PRIMARY KEY,
        database_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        created_time TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS status_groups_cache (
        database_id TEXT PRIMARY KEY,
        status_groups TEXT NOT NULL,
        last_edited_time TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      );


      CREATE TABLE IF NOT EXISTS database_cache (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      );

      -- Time tracking and sync state
      CREATE TABLE IF NOT EXISTS time_entries_sync (
        id TEXT PRIMARY KEY,
        toggl_id TEXT,
        focus_id TEXT,
        processed_at INTEGER,
        pillar_id TEXT,
        duration INTEGER,
        description TEXT,
        project_name TEXT
      );

      CREATE TABLE IF NOT EXISTS streaks_data (
        id TEXT PRIMARY KEY,
        streak_name TEXT,
        current_count INTEGER,
        last_updated TEXT,
        data_hash TEXT,
        notion_page_id TEXT
      );

      CREATE TABLE IF NOT EXISTS todoist_sync_mapping (
        notion_id TEXT PRIMARY KEY,
        todoist_id TEXT NOT NULL,
        last_synced INTEGER NOT NULL,
        sync_hash TEXT,
        notion_last_edited TEXT,
        todoist_last_edited TEXT,
        notion_hash TEXT,
        todoist_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS temporal_sync (
        date TEXT PRIMARY KEY,
        day_id TEXT,
        week_id TEXT,
        created_at INTEGER,
        synced_at INTEGER,
        week_start_date TEXT,
        previous_day_id TEXT
      );

      -- Toggl project to Notion pillar mappings
      CREATE TABLE IF NOT EXISTS project_pillar_mapping (
        toggl_project_id TEXT PRIMARY KEY,
        notion_pillar_id TEXT,
        project_name TEXT,
        pillar_name TEXT,
        updated_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_task_cache_database_id ON task_cache(database_id);
      CREATE INDEX IF NOT EXISTS idx_project_cache_database_id ON project_cache(database_id);
      CREATE INDEX IF NOT EXISTS idx_tag_cache_database_id ON tag_cache(database_id);
      CREATE INDEX IF NOT EXISTS idx_cache_metadata_type ON cache_metadata(cache_type);
      CREATE INDEX IF NOT EXISTS idx_time_entries_toggl_id ON time_entries_sync(toggl_id);
      CREATE INDEX IF NOT EXISTS idx_time_entries_pillar_id ON time_entries_sync(pillar_id);
      CREATE INDEX IF NOT EXISTS idx_temporal_sync_date ON temporal_sync(date);
      CREATE INDEX IF NOT EXISTS idx_project_pillar_mapping_project ON project_pillar_mapping(toggl_project_id);
    `);

    // Prepare statements for better performance
    this.statements = {
      // Cache metadata
      getCacheMetadata: this.db.prepare('SELECT * FROM cache_metadata WHERE database_id = ? AND cache_type = ?'),
      setCacheMetadata: this.db.prepare(`
        INSERT OR REPLACE INTO cache_metadata (database_id, cache_type, last_edited_time, cached_at)
        VALUES (?, ?, ?, ?)
      `),

      // Task cache
      getCachedTasks: this.db.prepare('SELECT * FROM task_cache WHERE database_id = ?'),
      setCachedTask: this.db.prepare(`
        INSERT OR REPLACE INTO task_cache 
        (id, database_id, title, properties, url, created_time, last_edited_time, cached_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      deleteCachedTasks: this.db.prepare('DELETE FROM task_cache WHERE database_id = ?'),
      getMostRecentTaskTime: this.db.prepare(`
        SELECT MAX(last_edited_time) as max_time 
        FROM task_cache 
        WHERE database_id = ? AND last_edited_time IS NOT NULL
      `),

      // Project cache
      getCachedProjects: this.db.prepare('SELECT * FROM project_cache WHERE database_id = ?'),
      setCachedProject: this.db.prepare(`
        INSERT OR REPLACE INTO project_cache 
        (id, database_id, title, url, created_time, status, cached_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      deleteCachedProjects: this.db.prepare('DELETE FROM project_cache WHERE database_id = ?'),

      // Tag cache
      getCachedTags: this.db.prepare('SELECT * FROM tag_cache WHERE database_id = ?'),
      setCachedTag: this.db.prepare(`
        INSERT OR REPLACE INTO tag_cache 
        (id, database_id, title, url, created_time, cached_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      deleteCachedTags: this.db.prepare('DELETE FROM tag_cache WHERE database_id = ?'),

      // Status groups
      getCachedStatusGroups: this.db.prepare('SELECT * FROM status_groups_cache WHERE database_id = ?'),
      setCachedStatusGroups: this.db.prepare(`
        INSERT OR REPLACE INTO status_groups_cache 
        (database_id, status_groups, last_edited_time, cached_at)
        VALUES (?, ?, ?, ?)
      `),


      // Database cache
      getCachedDatabases: this.db.prepare('SELECT * FROM database_cache ORDER BY title'),
      setCachedDatabase: this.db.prepare(`
        INSERT OR REPLACE INTO database_cache 
        (id, title, url, cached_at)
        VALUES (?, ?, ?, ?)
      `),
      deleteDatabases: this.db.prepare('DELETE FROM database_cache')
    };
  }

  // Task caching methods
  async getCachedTasks(databaseId) {
    try {
      // First try with the ID as given
      let rows = this.statements.getCachedTasks.all(databaseId);
      
      // If no results and it looks like a UUID, try to find by database name
      // This handles the transition from storing by name to storing by ID
      if (rows.length === 0 && databaseId.includes('-')) {
        // Try common database names that might match this ID
        const possibleNames = ['Action Items', 'Day-End Chores', 'Evening Tasks', 
                               'Morning Routine', 'Packing List/Trip Tasks', 
                               'Tag/Knowledge Vault', "Today's Plan"];
        for (const name of possibleNames) {
          rows = this.statements.getCachedTasks.all(name);
          if (rows.length > 0) {
            console.log(`📋 Found cache under name '${name}' for ID ${databaseId}`);
            break;
          }
        }
      }
      
      if (rows.length === 0) return null;

      const tasks = rows.map(row => ({
        id: row.id,
        title: row.title,
        properties: JSON.parse(row.properties),
        url: row.url,
        created_time: row.created_time,
        ...(row.last_edited_time && { last_edited_time: row.last_edited_time })
      }));

      // Get metadata to return with tasks
      const metadata = this.statements.getCacheMetadata.get(databaseId, 'tasks');
      return {
        tasks,
        lastEditedTime: metadata?.last_edited_time,
        cachedAt: new Date(metadata?.cached_at || 0).toISOString()
      };
    } catch (error) {
      console.error('Error getting cached tasks:', error);
      return null;
    }
  }

  async setCachedTasks(databaseId, tasks, lastEditedTime) {
    const transaction = this.db.transaction((databaseId, tasks, lastEditedTime) => {
      const now = Date.now();

      // Update metadata first
      this.statements.setCacheMetadata.run(databaseId, 'tasks', lastEditedTime, now);

      // Delete existing cache for this database
      this.statements.deleteCachedTasks.run(databaseId);

      // Insert new tasks
      for (const task of tasks) {
        this.statements.setCachedTask.run(
          task.id,
          databaseId,
          task.title,
          JSON.stringify(task.properties),
          task.url,
          task.created_time,
          task.last_edited_time || null,
          now
        );
      }
    });

    transaction(databaseId, tasks, lastEditedTime);
  }

  async isTaskCacheValid(databaseId, currentLastEditedTime, checkRecentPages = false) {
    try {
      const metadata = this.statements.getCacheMetadata.get(databaseId, 'tasks');
      if (!metadata) return false;

      // Check if the database was modified after our cache
      const cachedTime = new Date(metadata.last_edited_time);
      const currentTime = new Date(currentLastEditedTime);
      
      // If database timestamp indicates changes, cache is invalid
      if (currentTime > cachedTime) {
        return false;
      }

      // For relation-sensitive queries, also check if cache is older than 1 hour
      if (checkRecentPages) {
        const cacheAge = Date.now() - metadata.cached_at;
        const oneHour = 60 * 60 * 1000;
        if (cacheAge > oneHour) {
          return false;
        }
      }
      
      return true;
    } catch (error) {
      return false;
    }
  }

  // Project caching methods
  async getCachedProjects(databaseId) {
    try {
      const rows = this.statements.getCachedProjects.all(databaseId);
      if (rows.length === 0) return null;

      const projects = rows.map(row => ({
        id: row.id,
        title: row.title,
        url: row.url,
        created_time: row.created_time,
        status: row.status
      }));

      const metadata = this.statements.getCacheMetadata.get(databaseId, 'projects');
      return {
        projects,
        lastEditedTime: metadata?.last_edited_time,
        cachedAt: new Date(metadata?.cached_at || 0).toISOString()
      };
    } catch (error) {
      console.error('Error getting cached projects:', error);
      return null;
    }
  }

  async setCachedProjects(databaseId, projects, lastEditedTime) {
    const transaction = this.db.transaction((databaseId, projects, lastEditedTime) => {
      const now = Date.now();

      // Update metadata first
      this.statements.setCacheMetadata.run(databaseId, 'projects', lastEditedTime, now);

      // Delete existing cache
      this.statements.deleteCachedProjects.run(databaseId);

      // Insert new projects
      for (const project of projects) {
        this.statements.setCachedProject.run(
          project.id,
          databaseId,
          project.title,
          project.url,
          project.created_time,
          project.status || null,
          now
        );
      }
    });

    transaction(databaseId, projects, lastEditedTime);
  }

  async isProjectCacheValid(databaseId, currentLastEditedTime) {
    try {
      const metadata = this.statements.getCacheMetadata.get(databaseId, 'projects');
      if (!metadata) return false;

      const cachedTime = new Date(metadata.last_edited_time);
      const currentTime = new Date(currentLastEditedTime);
      
      return currentTime <= cachedTime;
    } catch (error) {
      return false;
    }
  }

  // Tag caching methods
  async getCachedTags(databaseId) {
    try {
      const rows = this.statements.getCachedTags.all(databaseId);
      if (rows.length === 0) return null;

      const tags = rows.map(row => ({
        id: row.id,
        title: row.title,
        url: row.url,
        created_time: row.created_time
      }));

      const metadata = this.statements.getCacheMetadata.get(databaseId, 'tags');
      return {
        tags,
        lastEditedTime: metadata?.last_edited_time,
        cachedAt: new Date(metadata?.cached_at || 0).toISOString()
      };
    } catch (error) {
      console.error('Error getting cached tags:', error);
      return null;
    }
  }

  async setCachedTags(databaseId, tags, lastEditedTime) {
    const transaction = this.db.transaction((databaseId, tags, lastEditedTime) => {
      const now = Date.now();

      // Update metadata first
      this.statements.setCacheMetadata.run(databaseId, 'tags', lastEditedTime, now);

      // Delete existing cache
      this.statements.deleteCachedTags.run(databaseId);

      // Insert new tags
      for (const tag of tags) {
        this.statements.setCachedTag.run(
          tag.id,
          databaseId,
          tag.title,
          tag.url,
          tag.created_time,
          now
        );
      }
    });

    transaction(databaseId, tags, lastEditedTime);
  }

  async isTagCacheValid(databaseId, currentLastEditedTime) {
    try {
      const metadata = this.statements.getCacheMetadata.get(databaseId, 'tags');
      if (!metadata) return false;

      const cachedTime = new Date(metadata.last_edited_time);
      const currentTime = new Date(currentLastEditedTime);
      
      return currentTime <= cachedTime;
    } catch (error) {
      return false;
    }
  }

  // Status groups methods (keeping existing interface)
  async getCachedStatusGroups(databaseId) {
    try {
      const row = this.statements.getCachedStatusGroups.get(databaseId);
      if (!row) return null;

      return {
        statusGroups: JSON.parse(row.status_groups),
        lastEditedTime: row.last_edited_time,
        cachedAt: new Date(row.cached_at).toISOString()
      };
    } catch (error) {
      return null;
    }
  }

  async setCachedStatusGroups(databaseId, statusGroups, lastEditedTime) {
    this.statements.setCachedStatusGroups.run(
      databaseId,
      JSON.stringify(statusGroups),
      lastEditedTime,
      Date.now()
    );
  }

  async isCacheValid(databaseId, currentLastEditedTime) {
    try {
      const cached = await this.getCachedStatusGroups(databaseId);
      if (!cached) return false;

      const cachedTime = new Date(cached.lastEditedTime);
      const currentTime = new Date(currentLastEditedTime);
      
      return currentTime <= cachedTime;
    } catch (error) {
      return false;
    }
  }

  // Status groups logic (keeping existing interface)
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

  // Utility methods
  async clearCache() {
    this.db.exec(`
      DELETE FROM task_cache;
      DELETE FROM project_cache;
      DELETE FROM tag_cache;
      DELETE FROM status_groups_cache;
      DELETE FROM cache_metadata;
      DELETE FROM todoist_sync_mapping;
    `);
  }

  async invalidateTaskCache() {
    this.db.exec(`DELETE FROM task_cache; DELETE FROM cache_metadata WHERE cache_type = 'tasks';`);
  }

  async invalidateProjectCache() {
    this.db.exec(`DELETE FROM project_cache; DELETE FROM cache_metadata WHERE cache_type = 'projects';`);
  }

  async invalidateTagCache() {
    this.db.exec(`DELETE FROM tag_cache; DELETE FROM cache_metadata WHERE cache_type = 'tags';`);
  }

  async clearTasksCache(databaseId) {
    try {
      this.statements.deleteCachedTasks.run(databaseId);
      this.db.prepare('DELETE FROM cache_metadata WHERE database_id = ? AND cache_type = ?').run(databaseId, 'tasks');
    } catch (error) {
      console.error('Error clearing tasks cache:', error);
    }
  }


  async updateTasksInCache(databaseId, updatedTasks) {
    try {
      const now = Date.now();
      
      // Update specific tasks in the cache without invalidating everything
      const updateTask = this.db.prepare(`
        UPDATE task_cache 
        SET title = ?, properties = ?, url = ?, last_edited_time = ?, cached_at = ?
        WHERE id = ? AND database_id = ?
      `);
      
      const transaction = this.db.transaction((tasks) => {
        for (const task of tasks) {
          updateTask.run(
            task.title,
            JSON.stringify(task.properties),
            task.url,
            task.last_edited_time || null,
            now,
            task.id,
            databaseId
          );
        }
      });
      
      transaction(updatedTasks);
      
      // Also update the metadata timestamp to reflect that we've updated the cache
      const metadata = this.statements.getCacheMetadata.get(databaseId, 'tasks');
      if (metadata) {
        this.statements.setCacheMetadata.run(
          databaseId, 
          'tasks', 
          metadata.last_edited_time, 
          now
        );
      }
    } catch (error) {
      console.error('Error updating tasks in cache:', error);
      // Only invalidate if update fails
      await this.invalidateTaskCache();
    }
  }


  async getMostRecentTaskTime(databaseId) {
    try {
      const result = this.statements.getMostRecentTaskTime.get(databaseId);
      return result?.max_time || null;
    } catch (error) {
      console.error('Error getting most recent task time:', error);
      return null;
    }
  }

  // Database caching methods
  async getCachedDatabases() {
    try {
      const rows = this.statements.getCachedDatabases.all();
      if (rows.length === 0) return null;

      // Check if cache is older than 1 hour
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      if (rows[0].cached_at < oneHourAgo) {
        return null; // Cache expired
      }

      return rows.map(row => ({
        id: row.id,
        title: row.title,
        url: row.url
      }));
    } catch (error) {
      console.error('Error getting cached databases:', error);
      return null;
    }
  }

  async setCachedDatabases(databases) {
    try {
      const transaction = this.db.transaction(() => {
        // Clear existing databases
        this.statements.deleteDatabases.run();
        
        // Insert new databases
        const now = Date.now();
        for (const db of databases) {
          this.statements.setCachedDatabase.run(
            db.id,
            db.title,
            db.url,
            now
          );
        }
      });
      
      transaction();
    } catch (error) {
      console.error('Error setting cached databases:', error);
    }
  }

  async initSyncTables() {
    // Tables are already created in initDatabase, this is for compatibility
    return true;
  }

  async getSyncMappings() {
    try {
      const stmt = this.db.prepare('SELECT * FROM todoist_sync_mapping');
      return stmt.all();
    } catch (error) {
      console.error('Error getting sync mappings:', error);
      return [];
    }
  }

  async saveSyncMapping(notionId, todoistId, syncHash = null, metadata = {}) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO todoist_sync_mapping 
        (notion_id, todoist_id, last_synced, sync_hash, notion_last_edited, todoist_last_edited, notion_hash, todoist_hash) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        notionId, 
        todoistId, 
        Date.now(), 
        syncHash,
        metadata.notionLastEdited || null,
        metadata.todoistLastEdited || null,
        metadata.notionHash || null,
        metadata.todoistHash || null
      );
    } catch (error) {
      console.error('Error saving sync mapping:', error);
    }
  }

  async getSyncMapping(notionId) {
    try {
      const stmt = this.db.prepare('SELECT * FROM todoist_sync_mapping WHERE notion_id = ?');
      return stmt.get(notionId);
    } catch (error) {
      console.error('Error getting sync mapping:', error);
      return null;
    }
  }

  async deleteSyncMapping(notionId) {
    try {
      const stmt = this.db.prepare('DELETE FROM todoist_sync_mapping WHERE notion_id = ?');
      stmt.run(notionId);
    } catch (error) {
      console.error('Error deleting sync mapping:', error);
    }
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}