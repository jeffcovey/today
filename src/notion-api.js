import { Client } from '@notionhq/client';
import chalk from 'chalk';
import { StatusCache } from './status-cache.js';

export class NotionAPI {
  constructor(token) {
    this.notion = new Client({ auth: token });
    this.statusCache = new StatusCache();
  }

  async getDatabases() {
    try {
      const response = await this.notion.search({
        filter: {
          property: 'object',
          value: 'database'
        }
      });
      
      return response.results.map(db => ({
        id: db.id,
        title: db.title?.[0]?.plain_text || 'Untitled Database',
        url: db.url
      }));
    } catch (error) {
      throw new Error(`Failed to fetch databases: ${error.message}`);
    }
  }

  async getDatabaseItems(databaseId, pageSize = 100, options = {}) {
    try {
      // Check if we should use cache for this request
      if (options.useCache) {
        // Get database info to check last_edited_time
        const database = await this.notion.databases.retrieve({
          database_id: databaseId
        });

        const currentLastEditedTime = database.last_edited_time;

        // For relation-sensitive queries (like project assignments), be more conservative with caching
        const checkRecentPages = options.filterActionableItems || false;

        // Check if we have valid cached data
        if (await this.statusCache.isTaskCacheValid(databaseId, currentLastEditedTime, checkRecentPages)) {
          const cached = await this.statusCache.getCachedTasks(databaseId);
          if (cached && cached.tasks) {
            console.log('📋 Using cached task data');
            return cached.tasks;
          }
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

      const response = await this.notion.databases.query(queryParams);

      const tasks = response.results.map(page => ({
        id: page.id,
        title: this.extractTitle(page),
        properties: page.properties,
        url: page.url,
        created_time: page.created_time
      }));

      // Cache the results if caching is enabled
      if (options.useCache) {
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
      console.log(chalk.gray(`API call: updating page ${pageId}`));
      console.log(chalk.gray(`Properties:`, JSON.stringify(properties, null, 2)));
      
      const response = await this.notion.pages.update({
        page_id: pageId,
        properties
      });
      
      console.log(chalk.gray(`API response received - page updated`));
      console.log(chalk.gray(`Response properties:`, JSON.stringify(response.properties, null, 2)));
      return response;
    } catch (error) {
      console.error(chalk.red(`API Error for page ${pageId}:`), error);
      throw new Error(`Failed to update page ${pageId}: ${error.message}`);
    }
  }

  async batchUpdatePages(updates) {
    const results = [];
    for (const update of updates) {
      try {
        const response = await this.updatePageProperties(update.pageId, update.properties);
        results.push({ pageId: update.pageId, success: true, response });
      } catch (error) {
        console.error(`Error updating page ${update.pageId}:`, error.message);
        results.push({ 
          pageId: update.pageId, 
          success: false, 
          error: error.message 
        });
      }
    }
    return results;
  }

  async getActionableItems(databaseId, pageSize = 100, useCache = true) {
    return this.getDatabaseItems(databaseId, pageSize, {
      filterActionableItems: true,
      sortByCreated: true,
      useCache: useCache
    });
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

  extractTitle(page) {
    // Try to find a title property
    for (const value of Object.values(page.properties)) {
      if (value.type === 'title' && value.title?.[0]?.plain_text) {
        return value.title[0].plain_text;
      }
    }
    
    // Fallback to any rich_text property
    for (const value of Object.values(page.properties)) {
      if (value.type === 'rich_text' && value.rich_text?.[0]?.plain_text) {
        return value.rich_text[0].plain_text;
      }
    }
    
    return 'Untitled';
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
}