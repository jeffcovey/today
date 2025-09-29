#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';

async function deduplicateTasks() {
  const tasksDir = 'vault/notion-migration/tasks';

  // Read all task files
  const files = await fs.readdir(tasksDir);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  // Map to store notion_id -> array of files
  const idToFiles = new Map();

  console.log(`Processing ${mdFiles.length} files...`);

  // Group files by notion_id
  for (const file of mdFiles) {
    const content = await fs.readFile(path.join(tasksDir, file), 'utf-8');
    const match = content.match(/^notion_id:\s*"([^"]+)"/m);

    if (match) {
      const notionId = match[1];
      if (!idToFiles.has(notionId)) {
        idToFiles.set(notionId, []);
      }
      idToFiles.get(notionId).push(file);
    }
  }

  // Find duplicates
  const duplicates = [];
  let uniqueCount = 0;

  for (const [notionId, fileList] of idToFiles.entries()) {
    if (fileList.length > 1) {
      // Sort files to keep the one with highest number suffix
      fileList.sort((a, b) => {
        const numA = parseInt(a.match(/-(\d+)\.md$/)?.[1] || '0');
        const numB = parseInt(b.match(/-(\d+)\.md$/)?.[1] || '0');
        return numB - numA; // Descending order
      });

      // Keep the first (highest numbered), delete the rest
      const toKeep = fileList[0];
      const toDelete = fileList.slice(1);

      duplicates.push({
        notionId,
        keep: toKeep,
        delete: toDelete
      });
    } else {
      uniqueCount++;
    }
  }

  console.log(`\nFound ${duplicates.length} notion_ids with duplicates`);
  console.log(`Found ${uniqueCount} unique notion_ids`);

  // Calculate files to delete
  const filesToDelete = duplicates.flatMap(d => d.delete);
  console.log(`\nWill delete ${filesToDelete.length} duplicate files`);

  // Show some examples
  console.log('\nExamples of duplicates (first 5):');
  duplicates.slice(0, 5).forEach(dup => {
    console.log(`\n  Notion ID: ${dup.notionId}`);
    console.log(`    Keep: ${dup.keep}`);
    console.log(`    Delete: ${dup.delete.join(', ')}`);
  });

  // Delete duplicate files
  console.log('\nDeleting duplicate files...');
  let deleteCount = 0;

  for (const file of filesToDelete) {
    await fs.unlink(path.join(tasksDir, file));
    deleteCount++;
    if (deleteCount % 100 === 0) {
      console.log(`  Deleted ${deleteCount}/${filesToDelete.length} files...`);
    }
  }

  console.log(`\nDone! Deleted ${deleteCount} duplicate files.`);

  // Verify no duplicates remain
  const remainingFiles = await fs.readdir(tasksDir);
  const remainingMdFiles = remainingFiles.filter(f => f.endsWith('.md'));
  console.log(`\nRemaining files: ${remainingMdFiles.length}`);

  // Check for any remaining duplicates
  const checkMap = new Map();
  for (const file of remainingMdFiles) {
    const content = await fs.readFile(path.join(tasksDir, file), 'utf-8');
    const match = content.match(/^notion_id:\s*"([^"]+)"/m);
    if (match) {
      const notionId = match[1];
      if (checkMap.has(notionId)) {
        console.log(`WARNING: Still have duplicate for ${notionId}`);
      }
      checkMap.set(notionId, file);
    }
  }

  console.log(`Unique notion_ids after deduplication: ${checkMap.size}`);
}

deduplicateTasks().catch(console.error);