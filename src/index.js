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

// Temporal management commands
program
  .command('temporal')
  .description('Manage days and weeks in Notion')
  .option('--create-missing-days', 'Create missing day and week entries with relationships')
  .option('--start-date <date>', 'Start date for operations (YYYY-MM-DD)')
  .option('--end-date <date>', 'End date for operations (YYYY-MM-DD)')
  .action(async (options) => {
    try {
      const token = process.env.NOTION_TOKEN;
      if (!token) {
        console.error(chalk.red('NOTION_TOKEN environment variable is required'));
        process.exit(1);
      }

      const notionAPI = new NotionAPI(token);

      if (options.createMissingDays) {
        const startDate = options.startDate ? new Date(options.startDate) : null;
        const endDate = options.endDate ? new Date(options.endDate) : null;
        
        console.log(chalk.blue('Creating missing days and weeks...'));
        await notionAPI.createMissingDaysAndWeeks(startDate, endDate);
        console.log(chalk.green('✅ Successfully created missing days and weeks'));
      } else {
        console.log(chalk.yellow('No temporal operation specified. Use --help for options.'));
      }
    } catch (error) {
      console.error(chalk.red('Error in temporal operations:'), error.message);
      process.exit(1);
    }
  });

// Daily automation commands
program
  .command('daily')
  .description('Run daily automation tasks')
  .option('--reset-routines', 'Reset routine checkboxes to unchecked')
  .option('--mark-repeating-tasks', 'Reset completed repeating tasks')
  .option('--create-temporal', 'Create missing days/weeks')
  .option('--all', 'Run all daily automation tasks')
  .action(async (options) => {
    try {
      const token = process.env.NOTION_TOKEN;
      if (!token) {
        console.error(chalk.red('NOTION_TOKEN environment variable is required'));
        process.exit(1);
      }

      const notionAPI = new NotionAPI(token);

      if (options.all || options.createTemporal) {
        console.log(chalk.blue('Creating missing days and weeks...'));
        await notionAPI.createMissingDaysAndWeeks();
      }

      if (options.all || options.resetRoutines) {
        console.log(chalk.blue('Resetting routine checkboxes...'));
        await notionAPI.resetRoutineCheckboxes();
      }

      if (options.all || options.markRepeatingTasks) {
        console.log(chalk.blue('Marking completed repeating tasks...'));
        await notionAPI.markCompletedRepeatingTasksAsRepeating();
      }

      if (!options.all && !options.resetRoutines && !options.markRepeatingTasks && !options.createTemporal) {
        console.log(chalk.yellow('No daily operation specified. Use --help for options.'));
      }

    } catch (error) {
      console.error(chalk.red('Error in daily operations:'), error.message);
      process.exit(1);
    }
  });

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
  .command('fetch-tasks')
  .description('Fetch and cache all tasks from Notion')
  .option('--verbose', 'Show detailed output')
  .option('--force', 'Force refresh cache even if valid')
  .action(async (options) => {
    try {
      const token = process.env.NOTION_TOKEN;
      if (!token) {
        console.error(chalk.red('NOTION_TOKEN environment variable is required'));
        process.exit(1);
      }

      const notionAPI = new NotionAPI(token);
      const { SQLiteCache } = await import('./sqlite-cache.js');
      const cache = new SQLiteCache();
      
      // Check if we have valid cached data first (unless forced)
      if (!options.force) {
        try {
          // Get cached task count
          const taskCount = cache.db.prepare('SELECT COUNT(*) as count FROM task_cache').get();
          if (taskCount && taskCount.count > 0) {
            // Check if cache is recent (within last hour)
            const oldestCache = cache.db.prepare('SELECT MIN(cached_at) as oldest FROM task_cache').get();
            const cacheAge = Date.now() - (oldestCache?.oldest || 0);
            const oneHour = 60 * 60 * 1000;
            
            if (cacheAge < oneHour) {
              console.log(chalk.green(`✅ Using cached ${taskCount.count} tasks (cached ${Math.round(cacheAge / 60000)} minutes ago)`));
              
              // Show stats from cache
              const stats = cache.db.prepare(`
                SELECT 
                  COUNT(*) as total,
                  COUNT(CASE WHEN json_extract(properties, '$.due_date') IS NOT NULL THEN 1 END) as with_due_dates,
                  COUNT(CASE WHEN date(json_extract(properties, '$.due_date')) = date('now') THEN 1 END) as due_today
                FROM task_cache
              `).get();
              
              if (stats) {
                console.log(chalk.gray(`  ${stats.with_due_dates} have due dates`));
                console.log(chalk.gray(`  ${stats.due_today} are due today`));
              }
              
              cache.close();
              return;
            }
          }
        } catch (error) {
          // Cache check failed, proceed with fetch
          if (options.verbose) {
            console.log(chalk.gray('Cache check failed:', error.message));
          }
        }
      }
      
      // Get all databases
      const databases = await notionAPI.getDatabases();
      console.log(chalk.blue(`Found ${databases.length} databases`));
      
      if (options.verbose) {
        console.log(chalk.gray('All databases:'));
        databases.forEach(db => {
          console.log(chalk.gray(`  - ${db.title}`));
        });
      }
      
      // Look for task-related databases - use broader matching
      const taskDatabases = databases.filter(db => {
        const lowerTitle = db.title.toLowerCase();
        // Include the actual database names from your Notion
        return lowerTitle.includes('action') || 
               lowerTitle.includes('task') || 
               lowerTitle.includes('todo') ||
               lowerTitle.includes('today') ||
               lowerTitle.includes('routine') ||
               lowerTitle.includes('now') ||
               lowerTitle.includes('then') ||
               lowerTitle.includes('morning') ||
               lowerTitle.includes('evening') ||
               lowerTitle.includes('chore') ||
               lowerTitle.includes('plan') ||
               db.title === 'Action Items';  // Exact match for your main task database
      });
      
      if (options.verbose) {
        console.log(chalk.gray(`Task databases: ${taskDatabases.map(d => d.title).join(', ')}`));
      }
      
      let allTasks = [];
      
      for (const db of taskDatabases) {
        const dbName = db.title;
        const dbId = db.id;
        try {
          console.log(chalk.gray(`  Fetching from ${dbName}...`));
          const items = await notionAPI.getDatabaseItems(dbId);
          
          // Extract task info from each item
          const tasks = items.map(item => ({
            id: item.id,
            database: dbName,
            title: item.properties?.Name?.title?.[0]?.text?.content ||
                   item.properties?.Task?.title?.[0]?.text?.content ||
                   item.properties?.Title?.title?.[0]?.text?.content ||
                   'Untitled',
            stage: item.properties?.Stage?.select?.name,
            status: item.properties?.Status?.select?.name,
            due_date: item.properties?.['Due Date']?.date?.start ||
                      item.properties?.['Do Date']?.date?.start ||
                      item.properties?.['Start/Repeat Date']?.date?.start,
            tags: item.properties?.Tags?.multi_select?.map(t => t.name).join(', '),
            priority: item.properties?.Priority?.select?.name,
            last_edited: item.last_edited_time
          }));
          
          allTasks = allTasks.concat(tasks);
          console.log(chalk.gray(`    Found ${tasks.length} tasks`));
        } catch (err) {
          console.error(chalk.red(`  Error fetching ${dbName}: ${err.message}`));
        }
      }
      
      // Store tasks in cache
      if (allTasks.length > 0) {
        const db = cache.db;
        
        // Clear old task_cache
        db.prepare('DELETE FROM task_cache').run();
        
        // Insert new tasks
        const insert = db.prepare(`
          INSERT INTO task_cache (id, database_id, title, properties, url, created_time, last_edited_time, cached_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        for (const task of allTasks) {
          insert.run(
            task.id,
            task.database,
            task.title,
            JSON.stringify(task),
            `https://notion.so/${task.id.replace(/-/g, '')}`,
            task.last_edited || new Date().toISOString(),
            task.last_edited || new Date().toISOString(),
            Date.now()
          );
        }
        
        console.log(chalk.green(`✅ Cached ${allTasks.length} tasks total`));
        
        // Show some stats
        const withDueDates = allTasks.filter(t => t.due_date).length;
        const today = new Date().toISOString().split('T')[0];
        const dueToday = allTasks.filter(t => t.due_date && t.due_date.startsWith(today)).length;
        
        console.log(chalk.gray(`  ${withDueDates} have due dates`));
        console.log(chalk.gray(`  ${dueToday} are due today`));
      } else {
        console.log(chalk.yellow('No tasks found in Notion'));
      }
      
      cache.close();
    } catch (error) {
      console.error(chalk.red('Error fetching tasks:'), error.message);
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
  .command('topic-review')
  .description('Review and categorize untopiced action items')
  .action(async () => {
    try {
      const { TopicAnalyzer } = await import('./topic-analyzer.js');
      const analyzer = new TopicAnalyzer();
      await analyzer.run();
    } catch (error) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Sync tasks between Notion and Todoist')
  .option('--notion-to-todoist', 'Sync from Notion to Todoist only')
  .option('--todoist-to-notion', 'Sync from Todoist to Notion only')
  .option('--project <name>', 'Todoist project name (default: "Notion Tasks")')
  .option('--dry-run', 'Preview what would be synced without making changes')
  .action(async (options) => {
    try {
      const notionToken = process.env.NOTION_TOKEN;
      const todoistToken = process.env.TODOIST_TOKEN;
      
      if (!notionToken) {
        console.error(chalk.red('Error: NOTION_TOKEN environment variable is required'));
        process.exit(1);
      }
      
      if (!todoistToken) {
        console.error(chalk.red('Error: TODOIST_TOKEN environment variable is required'));
        console.log(chalk.yellow('Get your token from: https://todoist.com/app/settings/integrations'));
        process.exit(1);
      }
      
      const { TodoistSync } = await import('./todoist-sync.js');
      const notionAPI = new NotionAPI(notionToken);
      const databases = await notionAPI.getDatabases();
      
      const actionItemsDB = databases.find(db => 
        db.title.toLowerCase().includes('action items')
      );
      
      if (!actionItemsDB) {
        console.error(chalk.red('Error: No "Action Items" database found'));
        process.exit(1);
      }
      
      const sync = new TodoistSync(todoistToken, notionAPI);
      const projectName = options.project || 'Notion Tasks';
      const dryRun = options.dryRun || false;
      
      if (options.notionToTodoist) {
        await sync.syncNotionToTodoist(actionItemsDB.id, projectName, dryRun);
      } else if (options.todoistToNotion) {
        await sync.syncTodoistToNotion(actionItemsDB.id, projectName, dryRun);
      } else {
        await sync.performTwoWaySync(actionItemsDB.id, projectName, dryRun);
      }
      
      if (dryRun) {
        console.log(chalk.magenta.bold('\n⚠️  This was a dry run. No changes were made.'));
        console.log(chalk.cyan('Remove --dry-run to perform the actual sync.'));
      }
      
    } catch (error) {
      console.error(chalk.red('Error during sync:'), error.message);
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