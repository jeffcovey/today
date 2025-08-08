import { TodoistApi } from '@doist/todoist-api-typescript';
import chalk from 'chalk';
import { SQLiteCache } from './sqlite-cache.js';
import crypto from 'crypto';
import { TodoistBatchSync } from './todoist-batch-sync.js';

export class TodoistSync {
  constructor(todoistToken, notionAPI) {
    this.todoist = new TodoistApi(todoistToken);
    this.batchSync = new TodoistBatchSync(todoistToken);
    this.notionAPI = notionAPI;
    this.syncCache = new SQLiteCache();
    this.syncMapping = new Map();
  }

  async initializeSyncMapping() {
    await this.syncCache.initSyncTables();
    const mappings = await this.syncCache.getSyncMappings();
    mappings.forEach(m => {
      this.syncMapping.set(m.notion_id, m.todoist_id);
    });
  }

  async reconstructMappingsFromTodoist(projectName) {
    console.log(chalk.gray('Checking for existing Todoist tasks with Notion IDs...'));
    
    const project = await this.getProject(projectName);
    if (!project) {
      return;
    }
    
    const taskResponse = await this.todoist.getTasks({ projectId: project.id });
    const todoistTasks = taskResponse.results || taskResponse || [];
    let reconstructed = 0;
    
    for (const task of todoistTasks) {
      // Look for Notion ID in description
      const notionIdMatch = task.description?.match(/ID:\s*([a-f0-9-]{36})/i) || 
                           task.description?.match(/notion\.so\/([a-f0-9]{32})/i);
      
      if (notionIdMatch) {
        let notionId = notionIdMatch[1];
        // Convert 32-char format to UUID format if needed
        if (!notionId.includes('-')) {
          notionId = [
            notionId.slice(0, 8),
            notionId.slice(8, 12),
            notionId.slice(12, 16),
            notionId.slice(16, 20),
            notionId.slice(20, 32)
          ].join('-');
        }
        
        if (!this.syncMapping.has(notionId)) {
          this.syncMapping.set(notionId, task.id);
          await this.syncCache.saveSyncMapping(notionId, task.id);
          reconstructed++;
        }
      }
    }
    
    if (reconstructed > 0) {
      console.log(chalk.green(`Reconstructed ${reconstructed} sync mappings from Todoist`));
    }
    
    return reconstructed;
  }

  async syncNotionToTodoist(databaseId, projectName = 'Notion Tasks', dryRun = false) {
    console.log(chalk.blue(`🔄 Starting Notion → Todoist sync${dryRun ? ' (DRY RUN)' : ''}...`));
    
    await this.initializeSyncMapping();
    
    // Try to reconstruct mappings from existing Todoist tasks
    if (this.syncMapping.size === 0) {
      await this.reconstructMappingsFromTodoist(projectName);
    }
    
    const notionTasks = await this.notionAPI.getTasksDueToday(databaseId, false); // Disable cache for sync
    console.log(`Found ${notionTasks.length} tasks with Start/Repeat Date on or before today in Notion`);
    
    // Count how many have Do Date set
    const tasksWithDoDate = notionTasks.filter(t => t.properties['Do Date']?.date?.start);
    const tasksWithoutDoDate = notionTasks.filter(t => !t.properties['Do Date']?.date?.start);
    
    if (tasksWithDoDate.length !== notionTasks.length) {
      console.log(chalk.gray(`  ${tasksWithDoDate.length} have Do Date set, ${tasksWithoutDoDate.length} without Do Date`));
    }
    
    // Also check for tasks that HAD mappings but no longer have dates or are in the future
    const syncedNotionIds = Array.from(this.syncMapping.keys());
    const currentNotionIds = new Set(notionTasks.map(t => t.id));
    const removedFromNotion = syncedNotionIds.filter(id => !currentNotionIds.has(id));
    
    if (removedFromNotion.length > 0) {
      console.log(chalk.yellow(`Found ${removedFromNotion.length} tasks that are no longer due today or earlier`));
    }
    
    // Debug: Check mapping size
    if (this.syncMapping.size > 0) {
      console.log(chalk.gray(`Active sync mappings: ${this.syncMapping.size}`));
    }
    
    let todoistProject = await this.getOrCreateProject(projectName, dryRun);
    
    let created = 0, updated = 0, skipped = 0, errors = 0;
    const actions = [];
    const total = notionTasks.length;
    
    // Collect all changes first
    const tasksToCreate = [];
    const tasksToUpdate = [];
    const mappingsToSave = [];
    
    console.log(chalk.gray('Analyzing changes...'));
    
    for (let i = 0; i < notionTasks.length; i++) {
      const notionTask = notionTasks[i];
      
      try {
        const taskData = this.extractNotionTaskData(notionTask);
        
        if (this.syncMapping.has(notionTask.id)) {
          const todoistId = this.syncMapping.get(notionTask.id);
          const existingMapping = await this.syncCache.getSyncMapping(notionTask.id);
          
          // Check if Notion has been modified since last sync
          const notionModified = !existingMapping || 
                                !existingMapping.notion_last_edited || 
                                new Date(taskData.lastEdited) > new Date(existingMapping.notion_last_edited);
          
          // Check which side was modified more recently
          let notionIsNewer = true;  // Default to Notion if no comparison possible
          if (notionModified && existingMapping && existingMapping.todoist_last_edited) {
            const notionTime = new Date(taskData.lastEdited);
            const todoistTime = new Date(existingMapping.todoist_last_edited);
            notionIsNewer = notionTime > todoistTime;
          }
          
          // Only sync from Notion to Todoist if Notion changed AND is newer
          if (notionModified && (!existingMapping || existingMapping.notion_hash !== taskData.hash) && notionIsNewer) {
            if (dryRun) {
              actions.push({
                action: 'UPDATE',
                notion: { id: notionTask.id, title: taskData.title },
                todoist: { id: todoistId },
                changes: {
                  title: taskData.title,
                  dueDate: taskData.dueDate,
                  status: taskData.isCompleted ? 'Complete' : 'Active',
                  priority: `P${5 - taskData.priority}`,
                  labels: taskData.labels
                }
              });
              updated++;
            } else {
              tasksToUpdate.push({
                id: todoistId,
                title: taskData.title,
                dueDate: taskData.dueDate,
                priority: taskData.priority,
                labels: taskData.labels,
                description: taskData.description,
                notionId: notionTask.id,
                hash: taskData.hash,
                lastEdited: taskData.lastEdited
              });
            }
          } else {
            skipped++;
          }
        } else {
          if (dryRun) {
            actions.push({
              action: 'CREATE',
              notion: { id: notionTask.id, title: taskData.title },
              todoist: { project: projectName },
              details: {
                title: taskData.title,
                dueDate: taskData.dueDate,
                status: taskData.isCompleted ? 'Complete' : 'Active',
                priority: `P${5 - taskData.priority}`,
                labels: taskData.labels
              }
            });
            created++;
          } else {
            tasksToCreate.push({
              ...taskData,
              notionId: notionTask.id
            });
          }
        }
      } catch (error) {
        console.error(chalk.red(`Failed to process task: ${error.message}`));
        errors++;
      }
    }
    
    // Execute batch operations if not dry run
    if (!dryRun) {
      // Batch create tasks
      if (tasksToCreate.length > 0) {
        console.log(chalk.cyan(`Creating ${tasksToCreate.length} tasks in batch...`));
        try {
          const tempIdMapping = await this.batchSync.batchCreateTasks(tasksToCreate, todoistProject.id);
          
          // Save mappings for created tasks
          for (const task of tasksToCreate) {
            const tempId = task.tempId;
            const todoistId = tempIdMapping[tempId];
            if (todoistId) {
              await this.syncCache.saveSyncMapping(task.notionId, todoistId, task.hash, {
                notionLastEdited: task.lastEdited,
                notionHash: task.hash,
                todoistLastEdited: new Date().toISOString()  // Set current time as Todoist's update time
              });
              this.syncMapping.set(task.notionId, todoistId);
              created++;
            }
          }
        } catch (error) {
          console.error(chalk.red(`Batch create failed: ${error.message}`));
          errors += tasksToCreate.length;
        }
      }
      
      // Batch update tasks
      if (tasksToUpdate.length > 0) {
        console.log(chalk.cyan(`Updating ${tasksToUpdate.length} tasks in batch...`));
        try {
          await this.batchSync.batchUpdateTasks(tasksToUpdate);
          
          // Save mappings for updated tasks
          for (const task of tasksToUpdate) {
            await this.syncCache.saveSyncMapping(task.notionId, task.id, task.hash, {
              notionLastEdited: task.lastEdited,
              notionHash: task.hash,
              todoistLastEdited: new Date().toISOString()  // Update Todoist's last edited time
            });
            updated++;
          }
        } catch (error) {
          console.error(chalk.red(`Batch update failed: ${error.message}`));
          errors += tasksToUpdate.length;
        }
      }
    }
    
    // Handle tasks that no longer have Do Dates (should be removed from Todoist)
    let deleted = 0;
    const tasksToDelete = [];
    
    if (removedFromNotion.length > 0) {
      console.log(chalk.gray('Checking for tasks to remove...'));
      
      for (const notionId of removedFromNotion) {
        const todoistId = this.syncMapping.get(notionId);
        if (todoistId) {
          try {
            // Check if the task still exists in Notion (just without a Do Date)
            let taskStillExists = false;
            try {
              const page = await this.notionAPI.notion.pages.retrieve({ page_id: notionId });
              taskStillExists = !page.archived;
            } catch (e) {
              // Task doesn't exist or we can't access it
              taskStillExists = false;
            }
            
            if (dryRun) {
              console.log(chalk.yellow(taskStillExists ? 
                `Would remove from Todoist: task no longer due today or earlier` :
                `Would remove from Todoist: task deleted from Notion`));
              deleted++;
            } else {
              tasksToDelete.push({ todoistId, notionId });
            }
          } catch (error) {
            console.error(chalk.red(`Failed to check task: ${error.message}`));
            errors++;
          }
        }
      }
      
      // Batch delete tasks if not dry run
      if (!dryRun && tasksToDelete.length > 0) {
        console.log(chalk.yellow(`Removing ${tasksToDelete.length} tasks from Todoist...`));
        try {
          await this.batchSync.batchDeleteTasks(tasksToDelete.map(t => t.todoistId));
          
          // Clean up mappings
          for (const { notionId } of tasksToDelete) {
            await this.syncCache.deleteSyncMapping(notionId);
            this.syncMapping.delete(notionId);
            deleted++;
          }
        } catch (error) {
          console.error(chalk.red(`Batch delete failed: ${error.message}`));
          errors += tasksToDelete.length;
        }
      }
    }
    
    // Clear the progress line
    if (!dryRun && notionTasks.length > 0) {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    }
    
    if (dryRun) {
      this.displayDryRunResults(actions, 'Notion → Todoist');
    }
    
    const summaryParts = [`${created} to create`, `${updated} to update`];
    if (deleted > 0) summaryParts.push(`${deleted} deleted`);
    summaryParts.push(`${skipped} unchanged`, `${errors} errors`);
    
    console.log(chalk.green(`✅ Sync ${dryRun ? 'preview' : 'complete'}: ${summaryParts.join(', ')}`));
    return { created, updated, deleted, skipped, errors, actions: dryRun ? actions : [] };
  }

  async syncTodoistToNotion(databaseId, projectName = 'Notion Tasks', dryRun = false) {
    console.log(chalk.blue(`🔄 Starting Todoist → Notion sync${dryRun ? ' (DRY RUN)' : ''}...`));
    
    await this.initializeSyncMapping();
    
    // Try to reconstruct mappings if empty
    if (this.syncMapping.size === 0) {
      await this.reconstructMappingsFromTodoist(projectName);
    }
    
    const project = await this.getProject(projectName);
    if (!project) {
      console.log(chalk.yellow('No Todoist project found'));
      return { created: 0, updated: 0, errors: 0 };
    }
    
    const taskResponse = await this.todoist.getTasks({ projectId: project.id });
    const todoistTasks = taskResponse.results || taskResponse || [];
    console.log(`Found ${todoistTasks.length} tasks in Todoist`);
    
    const reversedMapping = new Map();
    this.syncMapping.forEach((todoistId, notionId) => {
      reversedMapping.set(todoistId, notionId);
    });
    
    let created = 0, updated = 0, skipped = 0, errors = 0;
    const actions = [];
    const total = todoistTasks.length;
    
    // First pass: collect all updates to be made
    const updatePromises = [];
    const tasksToUpdate = [];
    
    console.log(chalk.gray('Analyzing changes...'));
    
    for (let i = 0; i < todoistTasks.length; i++) {
      const todoistTask = todoistTasks[i];
      
      try {
        const taskData = this.extractTodoistTaskData(todoistTask);
        
        // Check if we have a mapping OR if the task has a Notion ID in its description
        let notionId = reversedMapping.get(todoistTask.id);
        
        if (!notionId) {
          // Try to extract Notion ID from description
          const notionIdMatch = todoistTask.description?.match(/ID:\s*([a-f0-9-]{36})/i) || 
                               todoistTask.description?.match(/notion\.so\/([a-f0-9]{32})/i);
          
          if (notionIdMatch) {
            notionId = notionIdMatch[1];
            // Convert 32-char format to UUID format if needed
            if (!notionId.includes('-')) {
              notionId = [
                notionId.slice(0, 8),
                notionId.slice(8, 12),
                notionId.slice(12, 16),
                notionId.slice(16, 20),
                notionId.slice(20, 32)
              ].join('-');
            }
            
            // Save the mapping for future syncs
            if (!dryRun) {
              await this.syncCache.saveSyncMapping(notionId, todoistTask.id);
              this.syncMapping.set(notionId, todoistTask.id);
            }
          }
        }
        
        if (notionId) {
          // Get the last sync state
          const existingMapping = await this.syncCache.getSyncMapping(notionId);
          const todoistHash = this.generateTaskHash({
            title: taskData.title,
            dueDate: taskData.dueDate,
            isCompleted: taskData.isCompleted,
            priority: taskData.priority,
            tags: taskData.tags
          });
          
          // Check if Todoist has changed since last sync
          const todoistChanged = !existingMapping || 
                                !existingMapping.todoist_hash || 
                                existingMapping.todoist_hash !== todoistHash;
          
          // Check which side was modified more recently
          let todoistIsNewer = false;
          if (todoistChanged && existingMapping) {
            const todoistTime = new Date(taskData.lastEdited);
            const notionTime = existingMapping.notion_last_edited ? new Date(existingMapping.notion_last_edited) : new Date(0);
            todoistIsNewer = todoistTime > notionTime;
          }
          
          // Only sync from Todoist to Notion if Todoist changed AND is newer
          if (todoistChanged && (!existingMapping || todoistIsNewer)) {
            if (dryRun) {
              actions.push({
                action: 'UPDATE',
                todoist: { id: todoistTask.id, title: taskData.title },
                notion: { id: notionId },
                changes: {
                  title: taskData.title,
                  dueDate: taskData.dueDate,
                  status: taskData.isCompleted ? '✅ Done' : '🚀 In Progress',
                  priority: taskData.priority,
                  tags: taskData.tags
                }
              });
              updated++;
            } else {
              // Collect update for batch processing
              tasksToUpdate.push({
                notionId,
                todoistTask,
                taskData,
                todoistHash,
                existingMapping
              });
            }
          } else {
            skipped++;
          }
        } else if (taskData.dueDate) {
          if (dryRun) {
            actions.push({
              action: 'CREATE',
              todoist: { id: todoistTask.id, title: taskData.title },
              notion: { database: databaseId },
              details: {
                title: taskData.title,
                dueDate: taskData.dueDate,
                status: taskData.isCompleted ? '✅ Done' : '🚀 In Progress',
                priority: taskData.priority,
                tags: taskData.tags
              }
            });
            created++;
          } else {
            const notionTask = await this.createNotionTask(databaseId, taskData);
            await this.syncCache.saveSyncMapping(notionTask.id, todoistTask.id);
            this.syncMapping.set(notionTask.id, todoistTask.id);
            created++;
          }
        } else {
          skipped++;
        }
      } catch (error) {
        console.error(chalk.red(`Failed to sync task: ${error.message}`));
        errors++;
      }
    }
    
    // Process updates using existing batch infrastructure
    if (!dryRun && tasksToUpdate.length > 0) {
      console.log(chalk.cyan(`Updating ${tasksToUpdate.length} tasks in Notion...`));
      
      // Prepare updates in the format expected by batchUpdatePages
      const batchUpdates = tasksToUpdate.map(({ notionId, taskData }) => ({
        pageId: notionId,
        properties: this.buildNotionUpdateProperties(notionId, taskData)
      }));
      
      // Use existing batchUpdatePages with optimized settings
      const results = await this.notionAPI.batchUpdatePages(batchUpdates, {
        concurrency: 5,
        delayMs: 100,
        showProgress: true
      });
      
      // Update sync mappings for successful updates
      for (let i = 0; i < results.length; i++) {
        if (results[i].success) {
          const { notionId, todoistTask, todoistHash, existingMapping } = tasksToUpdate[i];
          
          // Get the updated page to get its last_edited_time
          const currentNotionPage = results[i].response;
          
          await this.syncCache.saveSyncMapping(notionId, todoistTask.id, null, {
            notionLastEdited: currentNotionPage.last_edited_time,
            todoistLastEdited: taskData.lastEdited,  // Save Todoist's last edited time
            todoistHash: todoistHash,
            notionHash: existingMapping?.notion_hash || null
          });
          updated++;
        } else {
          errors++;
        }
      }
    }
    
    if (dryRun) {
      this.displayDryRunResults(actions, 'Todoist → Notion');
    }
    
    console.log(chalk.green(`✅ Sync ${dryRun ? 'preview' : 'complete'}: ${created} to create, ${updated} to update, ${skipped} skipped, ${errors} errors`));
    return { created, updated, skipped, errors, actions: dryRun ? actions : [] };
  }

  extractNotionTaskData(notionTask) {
    const title = this.notionAPI.extractTitle(notionTask);
    // Use Do Date for syncing the actual due date to Todoist
    // Start/Repeat Date is just for filtering what tasks to include
    const doDate = notionTask.properties['Do Date']?.date?.start;
    const dueDate = doDate; // Only sync if Do Date is set
    
    const status = notionTask.properties['Status']?.status?.name;
    const priority = notionTask.properties['Priority']?.select?.name;
    const project = notionTask.properties['Project']?.relation?.[0]?.id;
    const tags = notionTask.properties['Tags']?.multi_select?.map(t => t.name) || [];
    const lastEdited = notionTask.last_edited_time;
    
    // Create clean Notion URL
    const notionUrl = notionTask.url || `https://www.notion.so/${notionTask.id.replace(/-/g, '')}`;
    
    // Build description with Notion link
    const description = [
      `📌 [View in Notion](${notionUrl})`,
      '',
      `ID: ${notionTask.id}`,
      project ? `Project: ${project}` : null
    ].filter(Boolean).join('\n');
    
    return {
      title,
      dueDate,
      isCompleted: status === '✅ Done',
      priority: this.mapNotionPriorityToTodoist(priority),
      labels: tags,
      description,
      lastEdited,
      notionUrl,
      hash: this.generateTaskHash({title, dueDate, status, priority, tags})
    };
  }

  generateTaskHash(data) {
    const content = JSON.stringify(data);
    return crypto.createHash('md5').update(content).digest('hex');
  }

  extractTodoistTaskData(todoistTask) {
    return {
      title: todoistTask.content,
      dueDate: todoistTask.due?.date || todoistTask.due?.datetime || null,  // Explicitly null if no date
      isCompleted: todoistTask.is_completed || false,  // Fixed: use is_completed not isCompleted
      priority: this.mapTodoistPriorityToNotion(todoistTask.priority),
      tags: todoistTask.labels || [],
      description: todoistTask.description,
      lastEdited: todoistTask.updated_at || todoistTask.created_at  // Track Todoist's last update time
    };
  }

  mapNotionPriorityToTodoist(notionPriority) {
    const mapping = {
      '🔴 Critical': 4,
      '🟠 High': 3,
      '🟡 Medium': 2,
      '⚪ Low': 1
    };
    return mapping[notionPriority] || 1;
  }

  mapTodoistPriorityToNotion(todoistPriority) {
    const mapping = {
      4: '🔴 Critical',
      3: '🟠 High',
      2: '🟡 Medium',
      1: '⚪ Low'
    };
    return mapping[todoistPriority] || '⚪ Low';
  }

  async getOrCreateProject(name, dryRun = false) {
    const response = await this.todoist.getProjects();
    const projects = response.results || response || [];
    let project = Array.isArray(projects) ? projects.find(p => p.name === name) : null;
    
    if (!project) {
      if (dryRun) {
        console.log(chalk.yellow(`Would create new Todoist project: ${name}`));
        return { id: 'dry-run-project-id', name };
      } else {
        project = await this.todoist.addProject({ name });
        console.log(chalk.green(`Created new Todoist project: ${name}`));
      }
    }
    
    return project;
  }

  async getProject(name) {
    const response = await this.todoist.getProjects();
    const projects = response.results || response || [];
    return Array.isArray(projects) ? projects.find(p => p.name === name) : null;
  }

  async createTodoistTask(taskData, projectId) {
    const task = await this.todoist.addTask({
      content: taskData.title,
      projectId: projectId,
      dueDate: taskData.dueDate,
      priority: taskData.priority,
      labels: taskData.labels,
      description: taskData.description
    });
    
    if (taskData.isCompleted) {
      await this.todoist.closeTask(task.id);
    }
    
    return task;
  }

  async updateTodoistTask(taskId, taskData) {
    await this.todoist.updateTask(taskId, {
      content: taskData.title,
      dueDate: taskData.dueDate,
      priority: taskData.priority,
      labels: taskData.labels,
      description: taskData.description
    });
    
    if (taskData.isCompleted) {
      await this.todoist.closeTask(taskId);
    } else {
      await this.todoist.reopenTask(taskId);
    }
  }

  async createNotionTask(databaseId, taskData) {
    try {
      // Get database schema to find correct property names
      const database = await this.notionAPI.notion.databases.retrieve({ database_id: databaseId });
      
      // Find the title property name
      let titlePropName = null;
      for (const [propName, propConfig] of Object.entries(database.properties)) {
        if (propConfig.type === 'title') {
          titlePropName = propName;
          break;
        }
      }
      
      if (!titlePropName) {
        throw new Error('Could not find title property in database');
      }
      
      const properties = {};
      
      // Set title property
      properties[titlePropName] = {
        title: [{ text: { content: taskData.title } }]
      };
      
      // Set Do Date if it exists
      if (database.properties['Do Date']) {
        properties['Do Date'] = {
          date: taskData.dueDate ? { start: taskData.dueDate } : null
        };
      }
      
      // Set Status if it exists
      if (database.properties['Status']) {
        properties['Status'] = {
          status: { name: taskData.isCompleted ? '✅ Done' : '🚀 In Progress' }
        };
      }
      
      // Set Priority if it exists
      if (database.properties['Priority']) {
        properties['Priority'] = {
          select: { name: taskData.priority }
        };
      }
      
      // Skip tags as Tag/Knowledge Vault is a relation
      
      const response = await this.notionAPI.notion.pages.create({
        parent: { database_id: databaseId },
        properties
      });
      
      return response;
    } catch (error) {
      console.error('Failed to create Notion task:', error.message);
      throw error;
    }
  }

  buildNotionUpdateProperties(pageId, taskData) {
    // This builds properties in the format expected by NotionAPI.updatePageProperties
    const properties = {};
    
    // We'll need to fetch the page schema, but for now use known property names
    // Title property - NotionAPI.updatePageProperties handles finding the right property
    if (taskData.title) {
      // Find title property dynamically in updatePageProperties
      properties['Action Item'] = {
        title: [{ text: { content: taskData.title } }]
      };
    }
    
    // Update Do Date if defined (Start/Repeat Date is a formula, can't be updated directly)
    // Tasks with Start/Repeat Date will have their due dates managed by Notion's repeating logic
    if (taskData.dueDate !== undefined) {
      properties['Do Date'] = {
        date: taskData.dueDate ? { start: taskData.dueDate } : null
      };
    }
    
    // Update Done checkbox for completion status
    if (taskData.isCompleted !== undefined) {
      properties['Done'] = {
        checkbox: taskData.isCompleted
      };
    }
    
    // Update Priority if provided
    if (taskData.priority) {
      properties['Priority'] = {
        select: { name: taskData.priority }
      };
    }
    
    return properties;
  }

  async updateNotionTask(pageId, taskData) {
    try {
      const properties = this.buildNotionUpdateProperties(pageId, taskData);
      await this.notionAPI.updatePageProperties(pageId, properties);
    } catch (error) {
      console.error(`Failed to update Notion task ${pageId}:`, error.message);
      throw error;
    }
  }

  displayDryRunResults(actions, direction) {
    if (actions.length === 0) {
      console.log(chalk.gray('\nNo changes needed'));
      return;
    }
    
    console.log(chalk.cyan(`\n📋 ${direction} Sync Preview:\n`));
    
    const creates = actions.filter(a => a.action === 'CREATE');
    const updates = actions.filter(a => a.action === 'UPDATE');
    
    if (creates.length > 0) {
      console.log(chalk.green.bold(`Tasks to Create (${creates.length}):`));
      creates.forEach((action, i) => {
        if (i < 5) {
          console.log(chalk.green(`  • ${action.details.title}`));
          if (action.details.dueDate) {
            console.log(chalk.gray(`    Due: ${new Date(action.details.dueDate).toLocaleDateString()}`));
          }
          if (action.details.labels?.length > 0) {
            console.log(chalk.gray(`    Labels: ${action.details.labels.join(', ')}`));
          }
          if (direction.includes('Todoist') && i === 0) {
            console.log(chalk.blue(`    📌 Each task will include a link back to Notion`));
          }
        } else if (i === 5) {
          console.log(chalk.gray(`  ... and ${creates.length - 5} more`));
        }
      });
      console.log();
    }
    
    if (updates.length > 0) {
      console.log(chalk.yellow.bold(`Tasks to Update (${updates.length}):`));
      updates.forEach((action, i) => {
        if (i < 5) {
          const title = action.todoist?.title || action.notion?.title || action.changes?.title || 'Task';
          console.log(chalk.yellow(`  • ${title}`));
          if (action.changes.dueDate) {
            console.log(chalk.gray(`    Due date: ${new Date(action.changes.dueDate).toLocaleDateString()}`));
          }
          if (action.changes.status) {
            console.log(chalk.gray(`    Status: ${action.changes.status}`));
          }
        } else if (i === 5) {
          console.log(chalk.gray(`  ... and ${updates.length - 5} more`));
        }
      });
      console.log();
    }
  }

  async performTwoWaySync(databaseId, projectName = 'Notion Tasks', dryRun = false) {
    console.log(chalk.blue.bold(`\n🔄 Starting two-way sync${dryRun ? ' (DRY RUN)' : ''}...\n`));
    
    if (!dryRun) {
      console.log(chalk.gray('Step 1/2: Syncing Notion → Todoist...'));
    }
    const notionToTodoist = await this.syncNotionToTodoist(databaseId, projectName, dryRun);
    
    if (!dryRun) {
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log(chalk.gray('\nStep 2/2: Syncing Todoist → Notion...'));
    }
    
    const todoistToNotion = await this.syncTodoistToNotion(databaseId, projectName, dryRun);
    
    console.log(chalk.green.bold(`\n✨ Two-way sync ${dryRun ? 'preview' : 'complete'}!`));
    
    const n2tParts = [`${notionToTodoist.created} created`, `${notionToTodoist.updated} updated`];
    if (notionToTodoist.deleted > 0) n2tParts.push(`${notionToTodoist.deleted} deleted`);
    n2tParts.push(`${notionToTodoist.skipped} unchanged`);
    
    console.log(chalk.cyan(`Notion → Todoist: ${n2tParts.join(', ')}`));
    console.log(chalk.cyan(`Todoist → Notion: ${todoistToNotion.created} created, ${todoistToNotion.updated} updated, ${todoistToNotion.skipped} unchanged`));
    
    if (notionToTodoist.errors > 0 || todoistToNotion.errors > 0) {
      console.log(chalk.yellow(`⚠️  Errors: ${notionToTodoist.errors + todoistToNotion.errors} tasks failed to sync`));
    }
    
    return { notionToTodoist, todoistToNotion };
  }
}