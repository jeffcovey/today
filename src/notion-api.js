import { Client } from '@notionhq/client';
import chalk from 'chalk';
import { SQLiteCache } from './sqlite-cache.js';
import { NotionAPIBase } from './notion-api-base.js';

export class NotionAPI extends NotionAPIBase {
  constructor(token) {
    super(token);
    this.statusCache = new SQLiteCache();
    this.databaseCache = new Map(); // Cache for database list
    this.databaseCacheExpiry = 0;
  }

  async getDatabases() {
    try {
      // First check SQLite cache
      const cachedDatabases = await this.statusCache.getCachedDatabases();
      if (cachedDatabases) {
        return cachedDatabases;
      }

      console.log('📋 Fetching databases from Notion API...');
      const response = await this.notion.search({
        filter: {
          property: 'object',
          value: 'database'
        }
      });
      
      const databases = response.results.map(db => ({
        id: db.id,
        title: db.title?.[0]?.plain_text || 'Untitled Database',
        url: db.url
      }));

      // Cache databases in SQLite
      await this.statusCache.setCachedDatabases(databases);

      return databases;
    } catch (error) {
      throw new Error(`Failed to fetch databases: ${error.message}`);
    }
  }

  async getDatabaseItems(databaseId, pageSize = 100, options = {}) {
    try {
      // Check if we should use cache for this request
      if (options.useCache) {
        const cached = await this.statusCache.getCachedTasks(databaseId);
        if (cached && cached.tasks && cached.tasks.length > 0) {
          console.log('📋 Using cached task data');
          
          // Check if we should do incremental sync
          const mostRecentTime = await this.statusCache.getMostRecentTaskTime(databaseId);
          if (mostRecentTime && !options.skipIncrementalSync) {
            // Fetch only newer items and merge
            try {
              const newerItems = await this.getDatabaseItemsIncremental(databaseId, mostRecentTime, options);
              if (newerItems.length > 0) {
                console.log(`📋 Synced ${newerItems.length} newer items`);
                // The incremental sync will update the cache, so get fresh cache
                const updatedCache = await this.statusCache.getCachedTasks(databaseId);
                return updatedCache?.tasks || cached.tasks;
              }
            } catch (incrementalError) {
              console.warn('Incremental sync failed, using cache:', incrementalError.message);
            }
          }
          
          return cached.tasks;
        }
      }

      const queryParams = {
        database_id: databaseId,
        page_size: pageSize
      };

      // Add filtering for actionable statuses if specified
      if (options.filterActionableItems) {
        try {
          const completeStatuses = await this.statusCache.getCompleteGroupStatuses(databaseId, this);
          
          if (completeStatuses.length === 0) {
            // Fallback - no Complete group found, don't filter
          } else if (completeStatuses.length === 1) {
            // Single status to exclude
            queryParams.filter = {
              property: 'Status',
              status: { 
                does_not_equal: completeStatuses[0]
              }
            };
          } else {
            // Multiple statuses to exclude - use compound filter
            queryParams.filter = {
              and: completeStatuses.map(status => ({
                property: 'Status',
                status: { 
                  does_not_equal: status
                }
              }))
            };
          }
        } catch (error) {
          // Fallback to hardcoded exclusion for this database
          queryParams.filter = {
            property: 'Status',
            status: { 
              does_not_equal: '✅ Done'
            }
          };
        }
      }

      // Add sorting by creation date if specified
      if (options.sortByCreated) {
        queryParams.sorts = [
          {
            timestamp: 'created_time',
            direction: 'descending'
          }
        ];
      }

      // Handle pagination if pageSize > 100 or if options.fetchAll is true
      let allResults = [];
      let hasMore = true;
      let nextCursor = undefined;
      const actualPageSize = Math.min(pageSize, 100); // Notion API max is 100 per request
      const fetchAll = options.fetchAll || pageSize > 100;
      
      while (hasMore && (fetchAll || allResults.length < pageSize)) {
        const currentQuery = {
          ...queryParams,
          page_size: actualPageSize,
          ...(nextCursor && { start_cursor: nextCursor })
        };

        const response = await this.notion.databases.query(currentQuery);
        
        allResults = allResults.concat(response.results);
        hasMore = response.has_more;
        nextCursor = response.next_cursor;
        
        // If not fetching all and we have enough results, break
        if (!fetchAll && allResults.length >= pageSize) {
          allResults = allResults.slice(0, pageSize);
          break;
        }
        
        // Add a small delay between requests to be nice to the API
        if (hasMore && fetchAll) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      const tasks = allResults.map(page => ({
        id: page.id,
        title: this.extractTitle(page),
        properties: page.properties,
        url: page.url,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time
      }));

      // Always cache the results (unless explicitly disabled)
      if (options.useCache !== false) {
        const database = await this.notion.databases.retrieve({
          database_id: databaseId
        });
        await this.statusCache.setCachedTasks(databaseId, tasks, database.last_edited_time);
      }

      return tasks;
    } catch (error) {
      throw new Error(`Failed to fetch database items: ${error.message}`);
    }
  }

  async getDatabaseSchema(databaseId) {
    try {
      const database = await this.notion.databases.retrieve({
        database_id: databaseId
      });

      const properties = {};
      for (const [key, value] of Object.entries(database.properties)) {
        properties[key] = {
          id: value.id,
          type: value.type,
          name: key,
          // Include additional details for relation properties
          ...(value.type === 'relation' && {
            relation: value.relation
          })
        };
      }

      return {
        id: database.id,
        title: database.title?.[0]?.plain_text || 'Untitled Database',
        properties,
        fullDatabase: database // Include full database object for detailed inspection
      };
    } catch (error) {
      throw new Error(`Failed to fetch database schema: ${error.message}`);
    }
  }

  async updatePageProperties(pageId, properties) {
    try {
      const response = await this.notion.pages.update({
        page_id: pageId,
        properties
      });
      
      return response;
    } catch (error) {
      console.error(chalk.red(`API Error for page ${pageId}:`), error);
      throw new Error(`Failed to update page ${pageId}: ${error.message}`);
    }
  }

  async batchUpdatePages(updates, options = {}) {
    const { 
      concurrency = 5, // Maximum concurrent requests
      delayMs = 100,    // Delay between batches to respect rate limits
      showProgress = updates.length > 10 // Show progress for larger batches
    } = options;

    // Process updates in concurrent batches
    const results = [];
    const totalBatches = Math.ceil(updates.length / concurrency);
    
    for (let i = 0; i < updates.length; i += concurrency) {
      const batch = updates.slice(i, i + concurrency);
      const batchNumber = Math.floor(i / concurrency) + 1;
      
      if (showProgress) {
        const processed = Math.min(i + concurrency, updates.length);
        console.log(chalk.gray(`  Processing batch ${batchNumber}/${totalBatches} (${processed}/${updates.length} items)...`));
      }
      
      // Process this batch concurrently
      const batchPromises = batch.map(async (update) => {
        try {
          const response = await this.updatePageProperties(update.pageId, update.properties);
          return { pageId: update.pageId, success: true, response };
        } catch (error) {
          console.error(`Error updating page ${update.pageId}:`, error.message);
          return { 
            pageId: update.pageId, 
            success: false, 
            error: error.message 
          };
        }
      });

      // Wait for all requests in this batch to complete
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Extract results from Promise.allSettled format
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // This shouldn't happen since we catch errors above, but just in case
          results.push({
            pageId: 'unknown',
            success: false,
            error: result.reason?.message || 'Unknown error'
          });
        }
      });

      // Add delay between batches to respect rate limits (except for last batch)
      if (i + concurrency < updates.length && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // Invalidate relevant caches after successful updates
    const successfulUpdates = results.filter(r => r.success);
    if (successfulUpdates.length > 0) {
      // Invalidate task cache since any page update could affect task status
      await this.statusCache.invalidateTaskCache();
      
      // Clear routine caches to ensure fresh data
      await this.statusCache.clearAllRoutineCache();
    }

    return results;
  }

  async getDatabaseItemsIncremental(databaseId, lastSyncTime, options = {}) {
    try {
      // Build filter for items newer than lastSyncTime
      const baseFilters = [];
      
      // Add the timestamp filter
      baseFilters.push({
        timestamp: 'last_edited_time',
        last_edited_time: {
          after: lastSyncTime
        }
      });

      // Add actionable item filters if specified
      if (options.filterActionableItems) {
        try {
          const completeStatuses = await this.statusCache.getCompleteGroupStatuses(databaseId, this);
          completeStatuses.forEach(status => {
            baseFilters.push({
              property: 'Status',
              status: { does_not_equal: status }
            });
          });
        } catch (error) {
          // Fallback to hardcoded exclusion
          baseFilters.push({
            property: 'Status',
            status: { does_not_equal: '✅ Done' }
          });
        }
      }

      const filter = baseFilters.length > 1 ? { and: baseFilters } : baseFilters[0];
      
      // Use centralized queryDatabase method
      const newerItems = await this.queryDatabase({
        databaseId,
        cacheKey: 'incrementalTasks',
        getCacheData: null, // Don't use cache for incremental
        setCacheData: null, // Don't cache incremental results separately
        isValidCache: null,
        filter,
        sorts: options.sortByCreated ? [{ timestamp: 'created_time', direction: 'descending' }] : null,
        pageSize: 100,
        fetchAll: true,
        mapResult: (page) => this.mapPage(page),
        useCache: false,
        logPrefix: '🔄'
      });

      // Merge with existing cache if we have new items
      if (newerItems.length > 0) {
        await this.mergeWithCache(databaseId, newerItems);
      }

      return newerItems;
    } catch (error) {
      throw new Error(`Incremental sync failed: ${error.message}`);
    }
  }

  async mergeWithCache(databaseId, newerItems) {
    try {
      const cached = await this.statusCache.getCachedTasks(databaseId);
      if (!cached || !cached.tasks) return;

      // Create a map of existing items by ID for efficient lookup
      const existingItemsMap = new Map(cached.tasks.map(item => [item.id, item]));
      
      // Update or add newer items
      for (const newerItem of newerItems) {
        existingItemsMap.set(newerItem.id, newerItem);
      }

      // Convert back to array
      const mergedTasks = Array.from(existingItemsMap.values());
      
      // Get database info for cache update
      const database = await this.notion.databases.retrieve({ database_id: databaseId });
      
      // Update cache with merged data
      await this.statusCache.setCachedTasks(databaseId, mergedTasks, database.last_edited_time);
    } catch (error) {
      console.error('Failed to merge with cache:', error.message);
    }
  }

  async getActionableItems(databaseId, pageSize = 100, useCache = true) {
    return this.getDatabaseItems(databaseId, pageSize, {
      filterActionableItems: true,
      sortByCreated: true,
      useCache: useCache
    });
  }

  async getTasksWithDoDate(databaseId, useCache = true) {
    try {
      // Build filter for Do Date tasks
      const baseFilter = {
        property: 'Do Date',
        date: { is_not_empty: true }
      };

      // Add status filter to exclude completed tasks
      let statusFilters = [];
      try {
        const completeStatuses = await this.statusCache.getCompleteGroupStatuses(databaseId, this);
        statusFilters = completeStatuses.map(status => ({
          property: 'Status',
          status: { does_not_equal: status }
        }));
      } catch (error) {
        // Fallback to hardcoded exclusion
        statusFilters = [{
          property: 'Status',
          status: { does_not_equal: '✅ Done' }
        }];
      }

      const filter = {
        and: [baseFilter, ...statusFilters]
      };

      // For now, don't use caching for Do Date filtered queries
      // TODO: Implement separate caching for filtered queries in SQLiteCache
      return await this.queryDatabase({
        databaseId,
        cacheKey: 'doDateTasks',
        getCacheData: null, // Disable cache get for now
        setCacheData: null, // Disable cache set for now
        isValidCache: null, // Disable cache validation for now
        filter,
        sorts: [{
          property: 'Do Date',
          direction: 'ascending'
        }],
        pageSize: 100,
        fetchAll: true,
        mapResult: (page) => this.mapPage(page),
        useCache: false, // Disable caching for filtered queries
        logPrefix: '📅'
      });
    } catch (error) {
      console.error('Error fetching Do Date tasks:', error);
      // Fallback to the old method if the new one fails
      console.log('Falling back to traditional filtering method...');
      const allItems = await this.getActionableItems(databaseId, 1000, useCache);
      return allItems.filter(item => {
        const doDateProp = item.properties['Do Date'];
        return doDateProp && doDateProp.date && doDateProp.date.start;
      }).sort((a, b) => {
        const dateA = new Date(a.properties['Do Date'].date.start);
        const dateB = new Date(b.properties['Do Date'].date.start);
        return dateA - dateB;
      });
    }
  }

  async getProjectsDatabase() {
    try {
      const databases = await this.getDatabases();
      const projectsDB = databases.find(db => 
        db.title.toLowerCase().includes('projects') || 
        db.title.toLowerCase().includes('project')
      );
      return projectsDB;
    } catch (error) {
      throw new Error(`Failed to find Projects database: ${error.message}`);
    }
  }

  async getTagsDatabase() {
    try {
      const databases = await this.getDatabases();
      const tagsDB = databases.find(db => 
        db.title.toLowerCase().includes('tag/knowledge vault') ||
        db.title.toLowerCase().includes('knowledge vault') ||
        db.title.toLowerCase().includes('tags')
      );
      return tagsDB;
    } catch (error) {
      throw new Error(`Failed to find Tag/Knowledge Vault database: ${error.message}`);
    }
  }

  async getMorningRoutineDatabase() {
    try {
      const databases = await this.getDatabases();
      const morningRoutineDB = databases.find(db => 
        db.title.toLowerCase().includes('morning routine')
      );
      
      if (!morningRoutineDB) {
        throw new Error('Morning Routine database not found');
      }
      
      return morningRoutineDB;
    } catch (error) {
      throw new Error(`Failed to find Morning Routine database: ${error.message}`);
    }
  }

  async getEveningTasksDatabase() {
    try {
      const databases = await this.getDatabases();
      const eveningTasksDB = databases.find(db => 
        db.title.toLowerCase().includes('evening tasks')
      );
      
      if (!eveningTasksDB) {
        throw new Error('Evening Tasks database not found');
      }
      
      return eveningTasksDB;
    } catch (error) {
      throw new Error(`Failed to find Evening Tasks database: ${error.message}`);
    }
  }

  async getDayEndChoresDatabase() {
    try {
      const databases = await this.getDatabases();
      const dayEndChoresDB = databases.find(db => 
        db.title.toLowerCase().includes('day-end chores')
      );
      
      if (!dayEndChoresDB) {
        throw new Error('Day-End Chores database not found');
      }
      
      return dayEndChoresDB;
    } catch (error) {
      throw new Error(`Failed to find Day-End Chores database: ${error.message}`);
    }
  }

  async getAllProjects() {
    try {
      const projectsDB = await this.getProjectsDatabase();
      if (!projectsDB) {
        throw new Error('Projects database not found');
      }

      // Check if we should use cache
      const database = await this.notion.databases.retrieve({
        database_id: projectsDB.id
      });
      const currentLastEditedTime = database.last_edited_time;

      // Check if we have valid cached data
      if (await this.statusCache.isProjectCacheValid(projectsDB.id, currentLastEditedTime)) {
        const cached = await this.statusCache.getCachedProjects(projectsDB.id);
        if (cached && cached.projects) {
          console.log('📁 Using cached project data');
          return cached.projects;
        }
      }

      const queryParams = {
        database_id: projectsDB.id,
        page_size: 100,
        // Filter out completed projects
        filter: {
          property: 'Status',
          status: { 
            does_not_equal: 'Completed'
          }
        },
        // Sort by status to group and prioritize projects
        sorts: [
          {
            property: 'Status',
            direction: 'ascending'
          },
          {
            timestamp: 'created_time',
            direction: 'descending'
          }
        ]
      };

      const response = await this.notion.databases.query(queryParams);

      const projects = response.results.map(page => ({
        id: page.id,
        title: this.extractTitle(page),
        url: page.url,
        created_time: page.created_time,
        status: this.getStatusValue(page.properties.Status)
      }));

      // Cache the results
      await this.statusCache.setCachedProjects(projectsDB.id, projects, database.last_edited_time);

      return projects;
    } catch (error) {
      throw new Error(`Failed to fetch projects: ${error.message}`);
    }
  }

  async getMorningRoutineItems() {
    try {
      // Check cache first
      const cached = await this.statusCache.getCachedRoutineItems('morning_routine');
      if (cached) {
        return cached.items;
      }

      const morningRoutineDB = await this.getMorningRoutineDatabase();
      if (!morningRoutineDB) {
        throw new Error('Morning Routine database not found');
      }

      const queryParams = {
        database_id: morningRoutineDB.id,
        page_size: 100,
        // Filter for items where Done is not checked
        filter: {
          property: 'Done',
          checkbox: { 
            equals: false
          }
        }
      };

      const response = await this.notion.databases.query(queryParams);
      
      const items = response.results.map(page => ({
        id: page.id,
        title: this.extractTitle(page),
        properties: page.properties,
        url: page.url,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time
      }));

      // Cache the results
      await this.statusCache.setCachedRoutineItems('morning_routine', items);

      return items;
    } catch (error) {
      throw new Error(`Failed to fetch morning routine items: ${error.message}`);
    }
  }

  async getEveningTasksItems() {
    try {
      // Check cache first
      const cached = await this.statusCache.getCachedRoutineItems('evening_tasks');
      if (cached) {
        return cached.items;
      }

      const eveningTasksDB = await this.getEveningTasksDatabase();
      if (!eveningTasksDB) {
        throw new Error('Evening Tasks database not found');
      }

      const queryParams = {
        database_id: eveningTasksDB.id,
        page_size: 100,
        // Filter for items where Done is not checked
        filter: {
          property: 'Done',
          checkbox: { 
            equals: false
          }
        }
      };

      const response = await this.notion.databases.query(queryParams);
      
      const items = response.results.map(page => ({
        id: page.id,
        title: this.extractTitle(page),
        properties: page.properties,
        url: page.url,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time
      }));

      // Cache the results
      await this.statusCache.setCachedRoutineItems('evening_tasks', items);

      return items;
    } catch (error) {
      throw new Error(`Failed to fetch evening tasks items: ${error.message}`);
    }
  }

  async getDayEndChoresItems() {
    try {
      // Check cache first
      const cached = await this.statusCache.getCachedRoutineItems('day_end_chores');
      if (cached) {
        return cached.items;
      }

      const dayEndChoresDB = await this.getDayEndChoresDatabase();
      if (!dayEndChoresDB) {
        throw new Error('Day-End Chores database not found');
      }

      const queryParams = {
        database_id: dayEndChoresDB.id,
        page_size: 100,
        // Filter for items where Done is not checked
        filter: {
          property: 'Done',
          checkbox: { 
            equals: false
          }
        }
      };

      const response = await this.notion.databases.query(queryParams);
      
      const items = response.results.map(page => ({
        id: page.id,
        title: this.extractTitle(page),
        properties: page.properties,
        url: page.url,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time
      }));

      // Cache the results
      await this.statusCache.setCachedRoutineItems('day_end_chores', items);

      return items;
    } catch (error) {
      throw new Error(`Failed to fetch day-end chores items: ${error.message}`);
    }
  }

  async getAllTags() {
    try {
      const tagsDB = await this.getTagsDatabase();
      if (!tagsDB) {
        throw new Error('Tag/Knowledge Vault database not found');
      }

      // Check if we should use cache
      const database = await this.notion.databases.retrieve({
        database_id: tagsDB.id
      });
      const currentLastEditedTime = database.last_edited_time;

      // Check if we have valid cached data
      if (await this.statusCache.isTagCacheValid(tagsDB.id, currentLastEditedTime)) {
        const cached = await this.statusCache.getCachedTags(tagsDB.id);
        if (cached && cached.tags) {
          console.log('🏷️  Using cached tag data');
          return cached.tags;
        }
      }

      const queryParams = {
        database_id: tagsDB.id,
        page_size: 100
        // Note: Not sorting by property since we don't know the exact property name
        // Tags will be sorted by creation date by default
      };

      const response = await this.notion.databases.query(queryParams);

      const tags = response.results.map(page => ({
        id: page.id,
        title: this.extractTitle(page),
        url: page.url,
        created_time: page.created_time
      }));

      // Sort tags alphabetically by title for better user experience
      tags.sort((a, b) => a.title.localeCompare(b.title));

      // Cache the results
      await this.statusCache.setCachedTags(tagsDB.id, tags, database.last_edited_time);

      return tags;
    } catch (error) {
      throw new Error(`Failed to fetch tags: ${error.message}`);
    }
  }


  formatPropertyValue(property) {
    switch (property.type) {
      case 'title':
      case 'rich_text':
        return property[property.type]?.[0]?.plain_text || '';
      case 'number':
        return property.number || '';
      case 'select':
        return property.select?.name || '';
      case 'multi_select':
        return property.multi_select?.map(s => s.name).join(', ') || '';
      case 'date':
        return property.date?.start || '';
      case 'checkbox':
        return property.checkbox ? 'Yes' : 'No';
      case 'url':
        return property.url || '';
      case 'email':
        return property.email || '';
      case 'phone_number':
        return property.phone_number || '';
      default:
        return '';
    }
  }

  getStatusValue(statusProperty) {
    if (statusProperty?.type === 'status' && statusProperty.status?.name) {
      return statusProperty.status.name;
    }
    return null;
  }

  async getStageOptions(databaseId) {
    try {
      const database = await this.notion.databases.retrieve({
        database_id: databaseId
      });

      const stageProperty = database.properties['Stage'];
      if (!stageProperty || stageProperty.type !== 'select') {
        throw new Error('Stage property not found or is not a select property');
      }

      return stageProperty.select.options.map(option => ({
        id: option.id,
        name: option.name,
        color: option.color
      }));
    } catch (error) {
      throw new Error(`Failed to get Stage options: ${error.message}`);
    }
  }

  async getUpdatedTasks(taskIds) {
    try {
      const updatedTasks = [];
      
      for (const taskId of taskIds) {
        const page = await this.notion.pages.retrieve({
          page_id: taskId
        });
        
        updatedTasks.push({
          id: page.id,
          title: this.extractTitle(page),
          properties: page.properties,
          url: page.url,
          created_time: page.created_time
        });
      }
      
      return updatedTasks;
    } catch (error) {
      throw new Error(`Failed to fetch updated tasks: ${error.message}`);
    }
  }

  async debugTask(taskId) {
    try {
      console.log(`🔍 Fetching task directly by ID: ${taskId}`);
      
      const page = await this.notion.pages.retrieve({
        page_id: taskId
      });
      
      console.log(`Task Title: ${this.extractTitle(page)}`);
      console.log(`Task ID: ${page.id}`);
      
      // Look for tag properties
      console.log('\n--- Tag-related Properties ---');
      for (const [propName, propValue] of Object.entries(page.properties)) {
        if (propName.toLowerCase().includes('tag') || propName.toLowerCase().includes('knowledge')) {
          console.log(`\nProperty "${propName}":`, JSON.stringify(propValue, null, 2));
        }
      }
      
      console.log('\n--- ALL Properties (first 20) ---');
      let count = 0;
      for (const [propName, propValue] of Object.entries(page.properties)) {
        if (count < 20) {
          console.log(`\n"${propName}" (${propValue.type}):`, JSON.stringify(propValue, null, 2));
          count++;
        }
      }
      
      return page;
    } catch (error) {
      console.error('Error fetching task:', error.message);
      throw error;
    }
  }

  async testTagAssignment(taskId, tagId) {
    try {
      console.log(`🧪 Testing tag assignment: Task ${taskId} -> Tag ${tagId}`);
      
      // First, verify the tag exists and is accessible
      console.log('\n0. Verifying tag exists:');
      try {
        const tagPage = await this.notion.pages.retrieve({ page_id: tagId });
        console.log(`✅ Tag found: ${this.extractTitle(tagPage)} (ID: ${tagPage.id})`);
      } catch (error) {
        console.log(`❌ Tag not accessible: ${error.message}`);
        return { success: false, error: 'Tag not accessible' };
      }
      
      // First, fetch current state
      console.log('\n1. Current state:');
      const beforePage = await this.notion.pages.retrieve({ page_id: taskId });
      const beforeTagProp = beforePage.properties['Tag/Knowledge Vault'];
      console.log('Before Tag/Knowledge Vault:', JSON.stringify(beforeTagProp, null, 2));
      
      // Try the new "Tag" property first
      console.log('\n2. Performing update using new "Tag" property...');
      let updateResponse;
      try {
        updateResponse = await this.notion.pages.update({
          page_id: taskId,
          properties: {
            'Tag': {
              relation: [{ id: tagId }]
            }
          }
        });
        console.log('✅ New "Tag" property update succeeded');
      } catch (error) {
        console.log('❌ New "Tag" property update failed:', error.message);
        
        // Fallback to old property
        console.log('\n2b. Trying old "Tag/Knowledge Vault" property...');
        try {
          updateResponse = await this.notion.pages.update({
            page_id: taskId,
            properties: {
              'Tag/Knowledge Vault': {
                relation: [{ id: tagId }]
              }
            }
          });
          console.log('✅ Old property update succeeded');
        } catch (oldError) {
          console.log('❌ Old property update also failed:', oldError.message);
          throw oldError;
        }
      }
      
      console.log('Update response received. Status: Success');
      console.log('Response Tag property:', JSON.stringify(updateResponse.properties['Tag'], null, 2));
      console.log('Response Tag/Knowledge Vault:', JSON.stringify(updateResponse.properties['Tag/Knowledge Vault'], null, 2));
      
      // Wait a moment and fetch again to see if it persisted
      console.log('\n3. Verifying persistence (waiting 2 seconds)...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const afterPage = await this.notion.pages.retrieve({ page_id: taskId });
      const afterTagProp = afterPage.properties['Tag'];
      const afterOldTagProp = afterPage.properties['Tag/Knowledge Vault'];
      console.log('After Tag property:', JSON.stringify(afterTagProp, null, 2));
      console.log('After Tag/Knowledge Vault:', JSON.stringify(afterOldTagProp, null, 2));
      
      // Compare
      const beforeCount = beforeTagProp?.relation?.length || 0;
      const afterCount = afterTagProp?.relation?.length || 0;
      
      if (afterCount > beforeCount) {
        console.log(`✅ Success: Tag assignment persisted (${beforeCount} -> ${afterCount} tags)`);
      } else {
        console.log(`❌ Failed: Tag assignment did not persist (${beforeCount} -> ${afterCount} tags)`);
      }
      
      return { success: afterCount > beforeCount, before: beforeTagProp, after: afterTagProp };
    } catch (error) {
      console.error('Error in test tag assignment:', error.message);
      throw error;
    }
  }

  async debugDatabaseItems(databaseId, limit = 5) {
    try {
      console.log('🔍 Fetching sample items to examine status property...');
      
      const response = await this.notion.databases.query({
        database_id: databaseId,
        page_size: limit
      });

      console.log(`\nFound ${response.results.length} items:`);
      
      response.results.forEach((page, index) => {
        console.log(`\n--- Item ${index + 1} ---`);
        console.log(`Title: ${this.extractTitle(page)}`);
        console.log(`ID: ${page.id}`);
        
        // Look for status property
        for (const [propName, propValue] of Object.entries(page.properties)) {
          if (propValue.type === 'status') {
            console.log(`Status Property "${propName}":`, JSON.stringify(propValue, null, 2));
          }
        }
      });

      // Also examine the database schema
      console.log('\n🔍 Examining database schema for status groups...');
      const schema = await this.getDatabaseSchema(databaseId);
      
      for (const [propName, propInfo] of Object.entries(schema.properties)) {
        if (propInfo.type === 'status') {
          console.log(`\n--- Status Property Schema: "${propName}" ---`);
          
          // Get the full property details
          const database = await this.notion.databases.retrieve({
            database_id: databaseId
          });
          
          const fullProperty = database.properties[propName];
          if (fullProperty && fullProperty.status) {
            console.log('Status Options:', JSON.stringify(fullProperty.status.options, null, 2));
            console.log('Status Groups:', JSON.stringify(fullProperty.status.groups, null, 2));
          }
        }
      }

      return response.results;
    } catch (error) {
      console.error('Error fetching debug items:', error.message);
      throw error;
    }
  }

  // Cleanup method to properly close database connections
  close() {
    if (this.statusCache && typeof this.statusCache.close === 'function') {
      this.statusCache.close();
    }
  }
}