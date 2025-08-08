import chalk from 'chalk';
import crypto from 'crypto';

export class TodoistBatchSync {
  constructor(todoistToken) {
    this.token = todoistToken;
    this.syncUrl = 'https://api.todoist.com/sync/v9/sync';
    this.syncToken = '*'; // Full sync on first request
  }

  generateUuid() {
    return crypto.randomUUID();
  }

  generateTempId() {
    return crypto.randomUUID();
  }

  async executeBatch(commands) {
    try {
      const response = await fetch(this.syncUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sync_token: this.syncToken,
          commands: JSON.stringify(commands)
        })
      });

      if (!response.ok) {
        throw new Error(`Sync API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      // Update sync token for incremental syncs
      if (result.sync_token) {
        this.syncToken = result.sync_token;
      }

      // Check for command errors
      if (result.sync_status) {
        const errors = [];
        for (const [uuid, status] of Object.entries(result.sync_status)) {
          if (status !== 'ok' && status.error) {
            errors.push(`Command ${uuid}: ${status.error}`);
          }
        }
        if (errors.length > 0) {
          console.error(chalk.red('Batch sync errors:'), errors);
        }
      }

      return result;
    } catch (error) {
      console.error(chalk.red('Batch sync failed:'), error.message);
      throw error;
    }
  }

  async batchCreateTasks(tasks, projectId) {
    console.log(chalk.blue(`Creating ${tasks.length} tasks in batch...`));
    
    // Generate commands with temp_ids
    const commands = tasks.map(task => {
      const tempId = this.generateTempId();
      task.tempId = tempId; // Store tempId on task object for later mapping
      
      return {
        type: 'item_add',
        uuid: this.generateUuid(),
        temp_id: tempId,
        args: {
          content: task.title,
          project_id: projectId,
          due: task.dueDate ? { date: task.dueDate } : undefined,
          priority: task.priority || 1,
          labels: task.labels || [],
          description: task.description || ''
        }
      };
    });

    const result = await this.executeBatch(commands);
    
    // Return mapping of temp_ids to real IDs
    return result.temp_id_mapping || {};
  }

  async batchUpdateTasks(updates) {
    console.log(chalk.blue(`Updating ${updates.length} tasks in batch...`));
    
    const commands = updates.map(update => ({
      type: 'item_update',
      uuid: this.generateUuid(),
      args: {
        id: update.id,
        content: update.title,
        due: update.dueDate !== undefined ? 
             (update.dueDate ? { date: update.dueDate } : null) : 
             undefined,
        priority: update.priority,
        labels: update.labels,
        description: update.description
      }
    }));

    // Filter out undefined properties
    commands.forEach(cmd => {
      Object.keys(cmd.args).forEach(key => {
        if (cmd.args[key] === undefined) {
          delete cmd.args[key];
        }
      });
    });

    return await this.executeBatch(commands);
  }

  async batchDeleteTasks(taskIds) {
    console.log(chalk.blue(`Deleting ${taskIds.length} tasks in batch...`));
    
    const commands = taskIds.map(id => ({
      type: 'item_delete',
      uuid: this.generateUuid(),
      args: { id }
    }));

    return await this.executeBatch(commands);
  }

  async batchCompleteTasks(taskIds) {
    console.log(chalk.blue(`Completing ${taskIds.length} tasks in batch...`));
    
    const commands = taskIds.map(id => ({
      type: 'item_complete',
      uuid: this.generateUuid(),
      args: { id }
    }));

    return await this.executeBatch(commands);
  }

  async batchUncompleteTasks(taskIds) {
    console.log(chalk.blue(`Uncompleting ${taskIds.length} tasks in batch...`));
    
    const commands = taskIds.map(id => ({
      type: 'item_uncomplete',
      uuid: this.generateUuid(),
      args: { id }
    }));

    return await this.executeBatch(commands);
  }

  async getProjectByName(name) {
    const response = await fetch(this.syncUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sync_token: '*',
        resource_types: JSON.stringify(['projects'])
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch projects: ${response.status}`);
    }

    const result = await response.json();
    const projects = result.projects || [];
    return projects.find(p => p.name === name);
  }

  async createProject(name) {
    const commands = [{
      type: 'project_add',
      uuid: this.generateUuid(),
      temp_id: this.generateTempId(),
      args: { name }
    }];

    const result = await this.executeBatch(commands);
    const tempId = commands[0].temp_id;
    const realId = result.temp_id_mapping?.[tempId];
    
    return realId;
  }

  async getAllTasks(projectId = null) {
    const body = {
      sync_token: '*',
      resource_types: JSON.stringify(['items'])
    };

    const response = await fetch(this.syncUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch tasks: ${response.status}`);
    }

    const result = await response.json();
    let tasks = result.items || [];
    
    if (projectId) {
      tasks = tasks.filter(t => t.project_id === projectId);
    }
    
    return tasks;
  }
}