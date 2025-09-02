#!/usr/bin/env node

// Import specific Notion tasks by their IDs

import { autoDotenvx } from './lib/dotenvx-loader.js';
autoDotenvx();

import { Client } from '@notionhq/client';
import { TaskManager } from '../src/task-manager.js';
import chalk from 'chalk';

const notionToken = process.env.NOTION_TOKEN;
if (!notionToken) {
  console.error(chalk.red('Error: NOTION_TOKEN environment variable not set'));
  process.exit(1);
}

const notion = new Client({ auth: notionToken });
const tm = new TaskManager();

// The specific Notion IDs we want to import
const targetIds = [
  '1745e778-3096-81c9-aa91-f112617ac9b6', // add one-hour log to length check
  '8d5013a5-3598-478f-87dd-94c8f5944fc7', // Add Photos
  '57583737-254e-467e-9138-f7203e5d5667', // Balance Bank Accounts
  '5fff8762-d5db-4904-98cb-d00d05c3748f', // Call Doctor For Annual Checkup
  '2506da30-22a1-4805-9499-4593efc43932', // Check average spending on OGM
  '0a091754-27ce-4eeb-bca3-43f9e64b3779', // Check deleted photos
  'dd9ea881-8698-48bb-bfe2-831b2ebb7697', // Check last minute cruises
  '83085535-4780-4e89-9389-a23ea77b9697', // Check my room prices
  '2375e778-3096-81c0-b6be-edc7227bc8af', // Check OlderGay Services
  'ec48635e-070c-4035-8814-6ea2def48aad', // Check OlderGay Services (duplicate?)
  '5962aba0-fc92-4f51-9f8d-1910626c2ddb', // Check OlderGay.Men Patreon comments
  '2824c892-60b9-4d4b-8dfa-2bcbbeb98ef9', // Check Patreon messages
  '1c15e778-3096-81bc-a682-c62574feec79', // check place and group updates
  '2f7702f6-2cbf-4a37-8b80-cc9946cb1313', // Check PPV Calendar
  '995a829e-37e3-402e-9691-eda80f8e060a', // Check PPV Posts
  '2375e778-3096-81f7-b8b7-d576e9f5d41d', // Check SAGE Events
  'cc300875-a779-41b0-8769-a308952a4c2a', // Check the AC filter
  '08967c80-777a-4910-bf08-29d8a0099b91', // Check the batteries in the door locks
  '2295e778-3096-8108-845e-ebb6f84af0b0', // Check the fridge water lines
  '2375e778-3096-8149-92b2-eb6d1d212b96', // Check The Prime Timers Facebook Group
  'd53af795-200d-4f78-b55e-cfb2113c2f00', // Check the solar system
  '2c37417f-a7ca-4311-a284-55cc9f0bc6cc', // check upcoming YNAB debits
  'ff13712a-8844-41dc-9f2c-cdc3c3dfdec6', // Contact A Friend
  '66f16943-5105-4cfb-8f0b-4cb0fab3cf9c', // differentiate Patreon levels
  '6581d1d3-ad22-4175-8c56-a19439761449', // Do "Now & Then" Tasks
  '44e7f24e-bc0f-4f7e-80e2-b09c91b7a6a0', // Do Weekly Review
  'fc7fb44f-9f93-4f60-8966-06e81f1acaa',  // Give Buster His Flea Treatment
  '4ed8d10b-37e0-4d64-ba6b-b9b364012115', // Log Today's Work
  'a23f983d-9d26-43d7-9ffa-713d397f0882', // Look for housesits
  '1ce5e778-3096-81e2-888b-e7d24209f2ab', // Look for protests
  '10d5e778-3096-8102-b57b-c7add5cd4ed7', // Lower the guest room prices
  'f58d59a0-847c-443d-bc6c-44d2caa58ab8', // Make A Budget In YNAB
  '2375e778-3096-81e5-a78a-e1198720fb1f', // Mark Photos of Members
  'ba92fc2a-de03-4352-bb8f-57ac230f77fe', // Plan Meals, Order Groceries
  '2da7f58d-c26b-4def-b3e5-66b3a3259195', // Process OGM tasks
  'e823e3f4-96bf-466a-b92a-5e80dd96da9d', // Prune OGM branches regularly
  '5fafebe9-dd56-4b58-b1c2-b14fc7a11467', // Put cards for OlderGay.Men at Tropics
  '20d5e778-3096-81a3-b85e-fa4424cb06c8', // Replace the batteries in the remotes
  '1825e778-3096-8020-94aa-da418d8dc25a', // Restore skipped tests
  'aa74f0d0-3818-449f-9a87-d408812efe8c', // Review & update house projects page
  '898fe465-22bc-46df-ae4b-d7352e4fad4a', // Set up focus modes
  '98627c10-e5a9-45ee-84dc-40410b14dfb0', // Skip Hello Fresh meals
  '5ec83563-719e-4530-9876-ec8b088a2d1c', // Start OG Tracking
  '992ffa77-c8ff-46b1-bc37-5429b95e4548', // Transfer notes from Drafts
  '8d746a24-5ea7-4b2b-b879-38febdf81ca6', // Update The Raspberry Pi
];

// Helper to extract title from Notion page
function extractTitle(page) {
  if (page.properties?.Name?.title?.length > 0) {
    return page.properties.Name.title.map(t => t.plain_text).join('');
  }
  if (page.properties?.Title?.title?.length > 0) {
    return page.properties.Title.title.map(t => t.plain_text).join('');
  }
  for (const [key, value] of Object.entries(page.properties || {})) {
    if (value.type === 'title' && value.title?.length > 0) {
      return value.title.map(t => t.plain_text).join('');
    }
  }
  return 'Untitled';
}

async function importSpecificTask(notionId) {
  try {
    // Fetch the task from Notion
    const page = await notion.pages.retrieve({ page_id: notionId });
    
    const props = page.properties;
    const title = extractTitle(page);
    const status = props.Status?.status?.name || '🗂️ To File';
    const doDate = props['Do Date']?.date?.start || null;
    const repeatDays = props['Repeat Every (Days)']?.number || null;
    const content = props.Description?.rich_text?.map(t => t.plain_text).join('') || '';
    
    // Check if already imported
    const existing = tm.db.prepare('SELECT id FROM tasks WHERE notion_id = ?').get(notionId);
    if (existing) {
      return { status: 'exists', title, id: existing.id };
    }
    
    // Create task
    const localId = tm.createTask({
      title,
      status,
      do_date: doDate,
      repeat_interval: repeatDays,
      content,
      notion_id: notionId,
      notion_url: page.url
    });
    
    // Handle topics/tags
    const topicRelations = props['Tag/Knowledge Vault']?.relation || [];
    for (const topicRef of topicRelations) {
      try {
        const topicPage = await notion.pages.retrieve({ page_id: topicRef.id });
        const topicTitle = extractTitle(topicPage);
        if (topicTitle && topicTitle !== 'Untitled') {
          tm.addTopicToTask(localId, topicTitle);
        }
      } catch (error) {
        // Ignore topic fetch errors
      }
    }
    
    return { status: 'imported', title, id: localId, doDate, repeatDays };
  } catch (error) {
    return { status: 'error', title: notionId, error: error.message };
  }
}

async function main() {
  try {
    console.log(chalk.bold('\n🚀 Importing Specific Notion Tasks\n'));
    console.log(chalk.blue(`Attempting to import ${targetIds.length} specific tasks...\n`));
    
    let imported = 0;
    let existed = 0;
    let errors = 0;
    
    for (const notionId of targetIds) {
      process.stdout.write(`Fetching ${notionId.substring(0, 8)}... `);
      const result = await importSpecificTask(notionId);
      
      if (result.status === 'imported') {
        console.log(chalk.green(`✓ ${result.title}`));
        if (result.doDate) {
          console.log(chalk.gray(`  Do Date: ${result.doDate}`));
        }
        if (result.repeatDays) {
          console.log(chalk.gray(`  Repeat: Every ${result.repeatDays} days`));
        }
        imported++;
      } else if (result.status === 'exists') {
        console.log(chalk.yellow(`⚠ Already exists: ${result.title}`));
        existed++;
      } else {
        console.log(chalk.red(`✗ Error: ${result.error}`));
        errors++;
      }
    }
    
    console.log(chalk.blue('\n📊 Summary:'));
    console.log(`  Imported: ${imported}`);
    console.log(`  Already existed: ${existed}`);
    console.log(`  Errors: ${errors}`);
    
    if (imported > 0) {
      console.log(chalk.blue('\n📝 Syncing to markdown...'));
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      await execAsync('bin/tasks sync');
      console.log(chalk.green('✅ Markdown files updated'));
    }
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    process.exit(1);
  } finally {
    tm.close();
  }
}

main();