#!/usr/bin/env node

import { TodoistApi } from '@doist/todoist-api-typescript';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

async function testTodoistAuth() {
  const todoistToken = process.env.TODOIST_TOKEN;
  
  console.log(chalk.blue('\n🔑 Testing Todoist Authentication...\n'));
  console.log(chalk.gray(`Token (first 10 chars): ${todoistToken?.substring(0, 10)}...`));
  console.log(chalk.gray(`Token length: ${todoistToken?.length} characters\n`));
  
  if (!todoistToken) {
    console.error(chalk.red('TODOIST_TOKEN not found in .env'));
    process.exit(1);
  }
  
  const todoist = new TodoistApi(todoistToken);
  
  try {
    // Try different API methods to debug
    console.log(chalk.blue('1. Testing getProjects()...'));
    try {
      const projects = await todoist.getProjects();
      console.log(chalk.green(`   ✓ Response type: ${typeof projects}`));
      console.log(chalk.green(`   ✓ Is array: ${Array.isArray(projects)}`));
      console.log(chalk.green(`   ✓ Project count: ${Array.isArray(projects) ? projects.length : 'N/A'}`));
      
      // Debug the actual response structure
      console.log(chalk.yellow(`   ✓ Keys: ${Object.keys(projects || {}).join(', ')}`));
      
      // Check if it's wrapped in a data property
      if (projects && projects.data) {
        console.log(chalk.yellow(`   ✓ Has data property, is array: ${Array.isArray(projects.data)}`));
      }
      
      if (Array.isArray(projects) && projects.length > 0) {
        console.log(chalk.cyan(`   ✓ First project: ${projects[0].name} (ID: ${projects[0].id})`));
      }
    } catch (e) {
      console.log(chalk.red(`   ✗ Error: ${e.message}`));
    }
    
    console.log(chalk.blue('\n2. Testing getTasks()...'));
    try {
      const tasks = await todoist.getTasks();
      console.log(chalk.green(`   ✓ Response type: ${typeof tasks}`));
      console.log(chalk.green(`   ✓ Is array: ${Array.isArray(tasks)}`));
      console.log(chalk.green(`   ✓ Task count: ${Array.isArray(tasks) ? tasks.length : 'N/A'}`));
      
      if (Array.isArray(tasks) && tasks.length > 0) {
        console.log(chalk.cyan(`   ✓ First task: ${tasks[0].content}`));
      }
    } catch (e) {
      console.log(chalk.red(`   ✗ Error: ${e.message}`));
    }
    
    // Try raw API request
    console.log(chalk.blue('\n3. Testing raw API request to /rest/v2/projects...'));
    try {
      const response = await fetch('https://api.todoist.com/rest/v2/projects', {
        headers: {
          'Authorization': `Bearer ${todoistToken}`
        }
      });
      
      console.log(chalk.green(`   ✓ HTTP Status: ${response.status}`));
      console.log(chalk.green(`   ✓ Status Text: ${response.statusText}`));
      
      if (response.ok) {
        const data = await response.json();
        console.log(chalk.green(`   ✓ Projects found: ${data.length}`));
        if (data.length > 0) {
          console.log(chalk.cyan(`   ✓ Projects: ${data.map(p => p.name).join(', ')}`));
        }
      } else {
        const errorText = await response.text();
        console.log(chalk.red(`   ✗ Error response: ${errorText}`));
      }
    } catch (e) {
      console.log(chalk.red(`   ✗ Error: ${e.message}`));
    }
    
  } catch (error) {
    console.error(chalk.red('\nGeneral error:'), error);
  }
}

testTodoistAuth();