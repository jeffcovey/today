#!/usr/bin/env node

const { Client } = require('@notionhq/client');

const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

async function inspectTask(taskId) {
  try {
    console.log(`Fetching task ${taskId}...`);
    const page = await notion.pages.retrieve({
      page_id: taskId
    });

    console.log('\n=== FULL PAGE OBJECT ===');
    console.log(JSON.stringify(page, null, 2));

    console.log('\n=== PROPERTIES ===');
    for (const [key, value] of Object.entries(page.properties || {})) {
      console.log(`\nProperty: "${key}"`);
      console.log(`Type: ${value.type}`);
      console.log('Value:', JSON.stringify(value, null, 2));
    }

    // Try to get blocks
    console.log('\n=== BLOCKS ===');
    const blocks = await notion.blocks.children.list({
      block_id: taskId,
      page_size: 10
    });

    console.log(`Found ${blocks.results.length} blocks`);
    blocks.results.forEach((block, i) => {
      console.log(`\nBlock ${i}: ${block.type}`);
      if (block[block.type]?.rich_text) {
        const text = block[block.type].rich_text.map(t => t.plain_text).join('');
        console.log(`Text: ${text}`);
      }
    });

  } catch (error) {
    console.error('Error:', error);
  }
}

// Test with the specific task
inspectTask('20cae7a6-8c0a-41c9-b73f-7b70d30bf8eb');