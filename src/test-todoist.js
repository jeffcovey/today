#!/usr/bin/env node

import { TodoistApi } from '@doist/todoist-api-typescript';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

async function listTodoistProjects() {
  const todoistToken = process.env.TODOIST_TOKEN;
  
  if (!todoistToken) {
    console.error(chalk.red('TODOIST_TOKEN not found in .env'));
    process.exit(1);
  }
  
  const todoist = new TodoistApi(todoistToken);
  
  try {
    // Test the API connection first
    console.log(chalk.blue('\n🔌 Testing Todoist API connection...\n'));
    
    console.log(chalk.blue('📂 Fetching Todoist projects...'));
    const projects = await todoist.getProjects();
    
    if (Array.isArray(projects) && projects.length > 0) {
      console.log(chalk.green(`Found ${projects.length} projects:\n`));
      
      for (const project of projects) {
        console.log(chalk.cyan(`📁 ${project.name}`));
        console.log(chalk.gray(`   ID: ${project.id}`));
        
        // Get tasks for this project
        const tasks = await todoist.getTasks({ projectId: project.id });
        console.log(chalk.gray(`   Tasks: ${tasks.length}`));
        
        // Check if any tasks have Notion IDs
        const tasksWithNotionIds = tasks.filter(t => 
          t.description?.includes('notion.so') || 
          t.description?.includes('ID:')
        );
        
        if (tasksWithNotionIds.length > 0) {
          console.log(chalk.yellow(`   Tasks with Notion IDs: ${tasksWithNotionIds.length}`));
          
          // Show first task as example
          if (tasksWithNotionIds[0]) {
            console.log(chalk.gray(`   Example: "${tasksWithNotionIds[0].content}"`));
          }
        }
        console.log();
      }
    } else {
      console.log(chalk.yellow('No projects found in Todoist'));
      
      // Try to get all tasks regardless of project
      console.log(chalk.blue('\n📋 Checking for tasks without projects...\n'));
      const allTasks = await todoist.getTasks();
      console.log(chalk.cyan(`Total tasks in Todoist: ${Array.isArray(allTasks) ? allTasks.length : 0}`));
      
      if (Array.isArray(allTasks) && allTasks.length > 0) {
        const tasksWithNotionIds = allTasks.filter(t => 
          t.description?.includes('notion.so') || 
          t.description?.includes('ID:')
        );
        console.log(chalk.yellow(`Tasks with Notion IDs: ${tasksWithNotionIds.length}`));
        
        if (tasksWithNotionIds.length > 0) {
          console.log(chalk.green('\nExample tasks with Notion IDs:'));
          tasksWithNotionIds.slice(0, 3).forEach(task => {
            console.log(chalk.gray(`  - "${task.content}"`));
            if (task.projectId) {
              console.log(chalk.gray(`    Project ID: ${task.projectId}`));
            }
          });
        }
      }
    }
  } catch (error) {
    console.error(chalk.red('Error fetching projects:'), error.message);
  }
}

listTodoistProjects();