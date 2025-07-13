#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { NotionAPI } from './notion-api.js';
import { CLIInterface } from './cli-interface.js';
import chalk from 'chalk';

dotenv.config();

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n\n👋 Goodbye!'));
  process.exit(0);
});

const program = new Command();

program
  .name('notion-cli')
  .description('CLI for batch editing Notion database items')
  .version('1.0.0');

program
  .command('edit')
  .description('Interactive mode to select and edit database items')
  .action(async () => {
    try {
      const token = process.env.NOTION_TOKEN;
      if (!token) {
        console.error(chalk.red('Error: NOTION_TOKEN environment variable is required'));
        console.log(chalk.yellow('Please create a .env file with your Notion integration token'));
        console.log(chalk.blue('Get your token from: https://www.notion.so/my-integrations'));
        process.exit(1);
      }

      const notionAPI = new NotionAPI(token);
      const cli = new CLIInterface(notionAPI);
      
      await cli.start();
    } catch (error) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

program
  .command('clear-cache')
  .description('Clear all cached data (tasks, projects, tags, status groups)')
  .action(async () => {
    try {
      const { SQLiteCache } = await import('./sqlite-cache.js');
      const cache = new SQLiteCache();
      await cache.clearCache();
      cache.close();
      console.log(chalk.green('✅ Cache cleared successfully'));
    } catch (error) {
      console.error(chalk.red('Error clearing cache:'), error.message);
      process.exit(1);
    }
  });

program
  .command('cache-info')
  .description('Show cache statistics and information')
  .action(async () => {
    try {
      const { SQLiteCache } = await import('./sqlite-cache.js');
      const cache = new SQLiteCache();
      
      // Get cache statistics
      const stats = cache.db.prepare(`
        SELECT 
          'Tasks' as type, COUNT(*) as count, 
          MIN(cached_at) as oldest, MAX(cached_at) as newest
        FROM task_cache
        UNION ALL
        SELECT 
          'Projects' as type, COUNT(*) as count,
          MIN(cached_at) as oldest, MAX(cached_at) as newest  
        FROM project_cache
        UNION ALL
        SELECT 
          'Tags' as type, COUNT(*) as count,
          MIN(cached_at) as oldest, MAX(cached_at) as newest
        FROM tag_cache
        UNION ALL
        SELECT 
          'Status Groups' as type, COUNT(*) as count,
          MIN(cached_at) as oldest, MAX(cached_at) as newest
        FROM status_groups_cache
      `).all();

      console.log(chalk.blue('\n📊 Cache Statistics:'));
      stats.forEach(stat => {
        if (stat.count > 0) {
          const oldestDate = new Date(stat.oldest).toLocaleString();
          const newestDate = new Date(stat.newest).toLocaleString();
          console.log(`${chalk.green(stat.type)}: ${stat.count} items`);
          console.log(`  Oldest: ${chalk.gray(oldestDate)}`);
          console.log(`  Newest: ${chalk.gray(newestDate)}`);
        } else {
          console.log(`${chalk.yellow(stat.type)}: No cached items`);
        }
      });

      cache.close();
    } catch (error) {
      console.error(chalk.red('Error getting cache info:'), error.message);
      process.exit(1);
    }
  });

program
  .command('debug')
  .description('Debug database items to examine status property structure')
  .option('--task <title>', 'Debug a specific task by title')
  .option('--task-id <id>', 'Debug a specific task by ID')
  .option('--test-tag-assignment <taskId,tagId>', 'Test tag assignment with specific task and tag IDs')
  .option('--check-schema', 'Check Action Items database schema for Tag/Knowledge Vault property')
  .option('--check-tag-db', 'Check Tag/Knowledge Vault database directly')
  .option('--list-all-dbs', 'List all databases with their IDs')
  .option('--find-tagged-tasks', 'Find tasks that have tags assigned')
  .option('--find-task <title>', 'Find a specific task by title')
  .action(async (options) => {
    try {
      const token = process.env.NOTION_TOKEN;
      if (!token) {
        console.error(chalk.red('Error: NOTION_TOKEN environment variable is required'));
        process.exit(1);
      }

      const notionAPI = new NotionAPI(token);
      
      // If test tag assignment requested, do that directly
      if (options.testTagAssignment) {
        const [taskId, tagId] = options.testTagAssignment.split(',');
        if (!taskId || !tagId) {
          console.error(chalk.red('Error: --test-tag-assignment requires taskId,tagId format'));
          process.exit(1);
        }
        await notionAPI.testTagAssignment(taskId.trim(), tagId.trim());
        return;
      }
      
      // If check tag database requested, do that directly
      if (options.checkTagDb) {
        console.log(chalk.blue('🏷️ Checking Tag/Knowledge Vault database...'));
        try {
          const tagDb = await notionAPI.getTagsDatabase();
          if (tagDb) {
            console.log(chalk.green(`Found tag database: ${tagDb.title}`));
            console.log(chalk.gray(`Database ID: ${tagDb.id}`));
            
            const tagSchema = await notionAPI.getDatabaseSchema(tagDb.id);
            console.log(chalk.blue('\nTag database properties:'));
            for (const [name, prop] of Object.entries(tagSchema.properties)) {
              console.log(`"${name}": ${prop.type} ${prop.id}`);
              if (prop.type === 'relation' && prop.relation) {
                console.log('  Relation config:', JSON.stringify(prop.relation, null, 2));
              }
            }
            
            // Check if tag exists
            const tagPages = await notionAPI.getDatabaseItems(tagDb.id);
            const targetTag = tagPages.find(tag => tag.id === '1175e778-3096-81d3-98ea-fe27fd603880');
            if (targetTag) {
              console.log(chalk.green(`\n✅ Target tag found: ${targetTag.title}`));
            } else {
              console.log(chalk.red(`\n❌ Target tag 1175e778-3096-81d3-98ea-fe27fd603880 not found`));
              console.log(chalk.blue(`Available tags (first 5):`));
              tagPages.slice(0, 5).forEach(tag => {
                console.log(`  - ${tag.title} (${tag.id})`);
              });
            }
          } else {
            console.log(chalk.red('Tag/Knowledge Vault database not found'));
          }
        } catch (error) {
          console.log(chalk.red(`Error checking tag database: ${error.message}`));
        }
        return;
      }
      
      // If check schema requested, do that directly
      if (options.checkSchema) {
        console.log(chalk.blue('Finding Action Items database...'));
        const databases = await notionAPI.getDatabases();
        const actionItemsDB = databases.find(db => 
          db.title.toLowerCase().includes('action items')
        );
        
        if (!actionItemsDB) {
          console.error(chalk.red('Action Items database not found'));
          process.exit(1);
        }
        
        console.log(chalk.blue(`Checking schema for: ${actionItemsDB.title}`));
        console.log(chalk.gray(`Action Items Database ID: ${actionItemsDB.id}`));
        const schema = await notionAPI.getDatabaseSchema(actionItemsDB.id);
        
        console.log(chalk.blue('All properties in database:'));
        for (const [propName, propDetails] of Object.entries(schema.properties)) {
          if (propName.toLowerCase().includes('tag') || propName.toLowerCase().includes('knowledge')) {
            console.log(chalk.green(`Found tag-related property: "${propName}"`), propDetails);
          }
        }
        
        const tagProperty = schema.properties['Tag/Knowledge Vault'];
        if (tagProperty) {
          console.log(chalk.green('Tag/Knowledge Vault property found in schema:'));
          console.log(JSON.stringify(tagProperty, null, 2));
          
          if (tagProperty.relation) {
            console.log(chalk.blue('\nRelation details:'));
            console.log(JSON.stringify(tagProperty.relation, null, 2));
          }
        } else {
          console.log(chalk.red('Tag/Knowledge Vault property not found in schema'));
          
          // Let's look at the full database object to see what we're missing
          console.log(chalk.blue('\nFull database properties (first 5):'));
          const fullDB = schema.fullDatabase;
          if (fullDB && fullDB.properties) {
            let count = 0;
            for (const [propName, propValue] of Object.entries(fullDB.properties)) {
              if (propName.toLowerCase().includes('tag') || propName.toLowerCase().includes('knowledge') || propValue.id === 'YubG' || count < 10) {
                console.log(`"${propName}":`, propValue.type, propValue.id || '');
                if (propValue.type === 'relation' && propValue.relation) {
                  console.log('  Relation config:', JSON.stringify(propValue.relation, null, 2));
                }
                count++;
              }
            }
            
            // Specifically search for YubG property
            console.log(chalk.blue('\nSearching specifically for YubG property:'));
            for (const [propName, propValue] of Object.entries(fullDB.properties)) {
              if (propValue.id === 'YubG') {
                console.log(chalk.green(`Found YubG property: "${propName}"`));
                console.log(JSON.stringify(propValue, null, 2));
                break;
              }
            }
          }
        }
        return;
      }
      
      // If list all databases requested, do that directly
      if (options.listAllDbs) {
        console.log(chalk.blue('Fetching all databases from Notion...'));
        const databases = await notionAPI.getDatabases();
        console.log(chalk.blue(`\nFound ${databases.length} databases:`));
        databases.forEach(db => {
          console.log(`${chalk.green(db.title)} - ${chalk.gray(db.id)}`);
        });
        return;
      }
      
      // If find tagged tasks requested, do that directly
      if (options.findTaggedTasks) {
        console.log(chalk.blue('Finding Action Items database...'));
        const databases = await notionAPI.getDatabases();
        const actionItemsDB = databases.find(db => 
          db.title.toLowerCase().includes('action items')
        );
        
        if (!actionItemsDB) {
          console.error(chalk.red('Action Items database not found'));
          process.exit(1);
        }
        
        console.log(chalk.blue('Fetching all Action Items...'));
        const allItems = await notionAPI.getDatabaseItems(actionItemsDB.id, 1000);
        
        console.log(chalk.blue(`\nExamining ${allItems.length} total items for tag properties:`));
        
        let taggedTasks = [];
        let untaggedTasks = [];
        
        allItems.forEach(item => {
          const tagProp = item.properties['Tag/Knowledge Vault'];
          if (tagProp && tagProp.relation && tagProp.relation.length > 0) {
            taggedTasks.push({
              title: item.title,
              id: item.id,
              tagCount: tagProp.relation.length
            });
          } else {
            untaggedTasks.push({
              title: item.title,
              id: item.id,
              tagProp: tagProp ? 'exists but empty' : 'does not exist'
            });
          }
        });
        
        console.log(chalk.green(`\nFound ${taggedTasks.length} tasks WITH tags:`));
        taggedTasks.slice(0, 10).forEach(task => {
          console.log(`  ✅ ${task.title} (${task.tagCount} tags) - ${task.id}`);
        });
        
        console.log(chalk.yellow(`\nFound ${untaggedTasks.length} tasks WITHOUT tags:`));
        untaggedTasks.slice(0, 5).forEach(task => {
          console.log(`  ❌ ${task.title} (${task.tagProp}) - ${task.id}`);
        });
        
        return;
      }
      
      // If find specific task requested, do that directly
      if (options.findTask) {
        console.log(chalk.blue('Finding Action Items database...'));
        const databases = await notionAPI.getDatabases();
        const actionItemsDB = databases.find(db => 
          db.title.toLowerCase().includes('action items')
        );
        
        if (!actionItemsDB) {
          console.error(chalk.red('Action Items database not found'));
          process.exit(1);
        }
        
        console.log(chalk.blue(`Searching for task: "${options.findTask}"`));
        const allItems = await notionAPI.getDatabaseItems(actionItemsDB.id, 1000, { useCache: false }); // Get ALL items including completed
        
        const matchingTasks = allItems.filter(item => 
          item.title.toLowerCase().includes(options.findTask.toLowerCase())
        );
        
        if (matchingTasks.length === 0) {
          console.log(chalk.red(`No tasks found containing "${options.findTask}"`));
          console.log(chalk.blue(`Showing ALL ${allItems.length} available tasks:`));
          allItems.forEach((item, index) => {
            console.log(`  ${index + 1}. ${item.title} (${item.id})`);
          });
        } else {
          console.log(chalk.green(`Found ${matchingTasks.length} matching tasks:`));
          matchingTasks.forEach(task => {
            console.log(chalk.blue(`\n--- ${task.title} ---`));
            console.log(`ID: ${task.id}`);
            console.log(`Created: ${task.created_time}`);
            
            // Check Tag/Knowledge Vault property specifically
            const tagProp = task.properties['Tag/Knowledge Vault'];
            if (tagProp) {
              console.log(`Tag/Knowledge Vault property:`, JSON.stringify(tagProp, null, 2));
            } else {
              console.log('❌ Tag/Knowledge Vault property not found');
            }
          });
        }
        return;
      }
      
      // Get databases and let user select one
      console.log(chalk.blue('Fetching your databases...'));
      const databases = await notionAPI.getDatabases();
      
      if (databases.length === 0) {
        console.log(chalk.yellow('No databases found.'));
        return;
      }

      // Find Projects database or let user choose
      let targetDB = databases.find(db => 
        db.title.toLowerCase().includes('projects') || 
        db.title.toLowerCase().includes('project')
      );

      if (!targetDB) {
        console.log(chalk.yellow('No "Projects" database found. Available databases:'));
        databases.forEach((db, i) => {
          console.log(`${i + 1}. ${db.title}`);
        });
        
        const { selection } = await (await import('inquirer')).default.prompt([
          {
            type: 'list',
            name: 'selection',
            message: 'Select a database to debug:',
            choices: databases.map(db => ({ name: db.title, value: db }))
          }
        ]);
        targetDB = selection;
      }

      console.log(chalk.green(`\nDebugging database: ${targetDB.title}`));
      
      // If specific task ID requested, debug it directly
      if (options.taskId) {
        await notionAPI.debugTask(options.taskId);
        return;
      }
      
      // If specific task requested, find and debug it
      if (options.task) {
        const items = await notionAPI.getDatabaseItems(targetDB.id, 1000); // Get more items to find specific task
        const specificTask = items.find(item => 
          item.title.toLowerCase().includes(options.task.toLowerCase())
        );
        
        if (specificTask) {
          console.log(chalk.blue(`\nFound task: ${specificTask.title}`));
          console.log(chalk.blue('Full task properties:'));
          console.log(JSON.stringify(specificTask.properties, null, 2));
          
          // Also try fetching the task directly by ID
          console.log(chalk.blue('\nFetching task directly by ID:'));
          const directTask = await notionAPI.notion.pages.retrieve({
            page_id: specificTask.id
          });
          console.log(chalk.blue('Direct fetch - Projects relation:'));
          console.log(JSON.stringify(directTask.properties['Projects (DB)'], null, 2));
        } else {
          console.log(chalk.red(`Task containing "${options.task}" not found`));
        }
      } else {
        // Fetch and examine items
        await notionAPI.debugDatabaseItems(targetDB.id);
      }
      
    } catch (error) {
      console.error(chalk.red('Debug error:'), error.message);
      process.exit(1);
    }
  });

if (process.argv.length === 2) {
  program.outputHelp();
} else {
  program.parse();
}