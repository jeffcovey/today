#!/usr/bin/env node

/**
 * Namespace all Notion properties with 'notion_' prefix to avoid conflicts
 * Preserves special properties that should not be renamed
 */

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';

const NOTION_MIGRATION_DIR = 'vault/notion-migration';

// Properties that should NOT be renamed (already namespaced or system properties)
const PRESERVE_PROPERTIES = [
  'notion_id',
  'notion_url',
  'notion_created_time',
  'notion_last_edited_time',
  'migration_status',
  'created_time',
  'last_edited_time'
];

// Properties that should be renamed to avoid conflicts
const RENAME_MAP = {
  'title': 'notion_title',
  'status': 'notion_status',
  'project': 'notion_project',
  'priority': 'notion_priority',
  'tags': 'notion_tags',
  'category': 'notion_category',
  'type': 'notion_type',
  'active': 'notion_active',
  'date': 'notion_date',
  'name': 'notion_name',
  'email': 'notion_email',
  'phone': 'notion_phone',
  'company': 'notion_company',
  'location': 'notion_location',
  'relationship': 'notion_relationship',
  'description': 'notion_description',
  'notes': 'notion_notes',
  'goals': 'notion_goals',
  'author': 'notion_author',
  'source': 'notion_source',
  'rating': 'notion_rating',
  'subject': 'notion_subject',
  'from': 'notion_from',
  'to': 'notion_to',
  'labels': 'notion_labels'
};

async function getAllMarkdownFiles(dir) {
  const files = [];

  async function traverse(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory() && entry.name !== '.migration') {
        await traverse(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  await traverse(dir);
  return files;
}

function processYamlFrontmatter(content) {
  // Extract frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return content;

  const frontmatter = frontmatterMatch[1];
  const body = content.substring(frontmatterMatch[0].length);

  // Process each line in frontmatter
  const lines = frontmatter.split('\n');
  const processedLines = lines.map(line => {
    // Skip empty lines or lines without colons
    if (!line.includes(':')) return line;

    // Extract the property name
    const colonIndex = line.indexOf(':');
    const propertyName = line.substring(0, colonIndex).trim();
    const propertyValue = line.substring(colonIndex);

    // Check if this property should be preserved
    if (PRESERVE_PROPERTIES.includes(propertyName)) {
      return line;
    }

    // Check if this property should be renamed
    if (RENAME_MAP[propertyName]) {
      return `${RENAME_MAP[propertyName]}${propertyValue}`;
    }

    // For any other property that doesn't start with notion_, add the prefix
    if (!propertyName.startsWith('notion_')) {
      // Special handling for snake_case properties that are likely from Notion
      if (propertyName.includes('_') ||
          propertyName.match(/^[a-z]+$/) ||
          propertyName.match(/^[a-z0-9_]+$/)) {
        return `notion_${propertyName}${propertyValue}`;
      }
    }

    return line;
  });

  return '---\n' + processedLines.join('\n') + '\n---' + body;
}

async function processFile(filepath) {
  try {
    const content = await fs.readFile(filepath, 'utf-8');
    const processedContent = processYamlFrontmatter(content);

    if (content !== processedContent) {
      await fs.writeFile(filepath, processedContent, 'utf-8');
      return true; // File was modified
    }
    return false; // File was unchanged
  } catch (error) {
    console.error(chalk.red(`Error processing ${filepath}: ${error.message}`));
    return false;
  }
}

async function main() {
  console.log(chalk.cyan.bold('\n🔧 Namespacing Notion Properties\n'));

  try {
    const files = await getAllMarkdownFiles(NOTION_MIGRATION_DIR);
    console.log(chalk.yellow(`Found ${files.length} markdown files\n`));

    let modified = 0;
    let processed = 0;

    for (const file of files) {
      if (processed % 100 === 0 && processed > 0) {
        console.log(chalk.blue(`Progress: ${processed}/${files.length} files processed`));
      }

      const wasModified = await processFile(file);
      if (wasModified) {
        modified++;
      }
      processed++;
    }

    console.log(chalk.cyan('\n📊 Summary:\n'));
    console.log(chalk.green(`  ✅ Modified: ${modified} files`));
    console.log(chalk.yellow(`  ⏭️  Unchanged: ${files.length - modified} files`));
    console.log(chalk.blue(`  📁 Total processed: ${files.length} files`));

    console.log(chalk.cyan('\n📝 Common Properties Namespaced:'));
    for (const [old, renamed] of Object.entries(RENAME_MAP).slice(0, 10)) {
      console.log(`  ${old} → ${renamed}`);
    }

  } catch (error) {
    console.error(chalk.red(`\n❌ Fatal error: ${error.message}`));
    console.error(error);
    process.exit(1);
  }
}

main();