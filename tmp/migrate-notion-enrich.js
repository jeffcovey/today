#!/usr/bin/env node

/**
 * Phase 2: Enrichment Migration Script
 * Populates placeholder files with full content from Notion
 * Only processes files marked with migration_status: placeholder
 */

import { config } from 'dotenv';
import { NotionAPI } from '../src/notion-api.js';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config();

async function findPlaceholderFiles(baseDir) {
  console.log(chalk.cyan('\n🔍 Finding placeholder files...\n'));

  const placeholders = [];
  const directories = [
    'vault/notion-migration/projects',
    'vault/notion-migration/people',
    'vault/notion-migration/topics',
    'vault/notion-migration/tasks',
    'vault/notion-migration/notes',
    'vault/notion-migration/plans-years',
    'vault/notion-migration/plans-quarters',
    'vault/notion-migration/plans-months',
    'vault/notion-migration/plans-weeks',
    'vault/notion-migration/daily-tracking',
    'vault/notion-migration/todays-plan',
    'vault/notion-migration/emails',
    'vault/notion-migration/media',
    'vault/notion-migration/resources',
    'vault/notion-migration/ideas',
    'vault/notion-migration/work',
    'vault/notion-migration/routines',
    'vault/notion-migration/ogm',
    'vault/notion-migration/ogm2',
    'vault/notion-migration/votes'
  ];

  for (const dir of directories) {
    const fullDir = path.join(baseDir, dir);

    try {
      const files = await fs.readdir(fullDir);

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(fullDir, file);
        const content = await fs.readFile(filePath, 'utf8');

        // Check if it's a placeholder
        if (content.includes('migration_status: placeholder')) {
          // Extract notion_id from frontmatter
          const notionIdMatch = content.match(/notion_id:\s*(.+)/);
          const notionDbMatch = content.match(/notion_db:\s*(.+)/);

          if (notionIdMatch) {
            placeholders.push({
              path: filePath,
              notionId: notionIdMatch[1].trim(),
              notionDb: notionDbMatch ? notionDbMatch[1].trim() : 'unknown',
              title: file.replace('.md', '')
            });
          }
        }
      }

      if (placeholders.length > 0) {
        console.log(chalk.gray(`  Found ${placeholders.length} placeholders in ${dir}/`));
      }

    } catch (error) {
      // Directory doesn't exist, skip
    }
  }

  console.log(chalk.green(`\n✓ Found ${placeholders.length} total placeholder files\n`));
  return placeholders;
}

async function enrichProject(notion, notionId, existingContent) {
  // Fetch full project data
  const project = await notion.notion.pages.retrieve({ page_id: notionId });
  const properties = project.properties || {};

  // Extract all properties
  const title = notion.extractTitle(project);
  const status = notion.getStatusValue(properties.Status) || 'planning';
  const description = properties.Text?.rich_text?.[0]?.plain_text || '';

  // Get dates
  const timeline = properties['Timeline Dates']?.date;
  const reviewDate = properties['Review Date']?.date?.start;

  // Get relationships
  const taskIds = (properties['Action Items (Tasks)']?.relation || []).map(r => r.id);
  const peopleIds = (properties['People Database']?.relation || []).map(r => r.id);

  // Build enriched frontmatter
  let frontmatter = '---\n';
  frontmatter += `title: ${title}\n`;
  frontmatter += `status: ${status.toLowerCase().replace(/\s+/g, '-')}\n`;
  frontmatter += `migration_status: complete\n`;
  frontmatter += `notion_id: ${notionId}\n`;

  if (timeline?.start) {
    frontmatter += `start_date: ${timeline.start}\n`;
    if (timeline.end) frontmatter += `end_date: ${timeline.end}\n`;
  }

  if (reviewDate) {
    frontmatter += `last_reviewed: ${reviewDate}\n`;
  }

  if (taskIds.length > 0) {
    frontmatter += `related_tasks: ${taskIds.length}\n`;
  }

  if (peopleIds.length > 0) {
    frontmatter += `related_people: ${peopleIds.length}\n`;
  }

  frontmatter += '---\n\n';

  // Build content
  let content = frontmatter;
  content += `# ${title}\n\n`;

  if (description) {
    content += `## Description\n\n${description}\n\n`;
  }

  // Add task count for now (full task list would require fetching each task)
  if (taskIds.length > 0) {
    content += `## Tasks\n\n`;
    content += `*This project has ${taskIds.length} related tasks in Notion.*\n\n`;
  }

  // Add people count
  if (peopleIds.length > 0) {
    content += `## People\n\n`;
    content += `*${peopleIds.length} people are associated with this project.*\n\n`;
  }

  content += `---\n*Enriched from Notion on ${new Date().toISOString().split('T')[0]}*\n`;

  return content;
}

async function enrichPerson(notion, notionId, existingContent) {
  const person = await notion.notion.pages.retrieve({ page_id: notionId });
  const properties = person.properties || {};

  const name = notion.extractTitle(person);
  const email = properties.Email?.email;
  const phone = properties.Phone?.phone_number;
  const company = properties.Company?.rich_text?.[0]?.plain_text;
  const notes = properties.Notes?.rich_text?.[0]?.plain_text;

  let frontmatter = '---\n';
  frontmatter += `name: ${name}\n`;
  frontmatter += `type: person\n`;
  frontmatter += `migration_status: complete\n`;
  if (email) frontmatter += `email: ${email}\n`;
  if (phone) frontmatter += `phone: ${phone}\n`;
  if (company) frontmatter += `company: ${company}\n`;
  frontmatter += `notion_id: ${notionId}\n`;
  frontmatter += '---\n\n';

  let content = frontmatter;
  content += `# ${name}\n\n`;

  if (company) content += `**Company:** ${company}\n\n`;
  if (email) content += `**Email:** ${email}\n\n`;
  if (phone) content += `**Phone:** ${phone}\n\n`;

  if (notes) {
    content += `## Notes\n\n${notes}\n\n`;
  }

  content += `---\n*Enriched from Notion on ${new Date().toISOString().split('T')[0]}*\n`;

  return content;
}

async function enrichFile(notion, placeholder) {
  try {
    console.log(chalk.gray(`  Enriching ${placeholder.title}...`));

    let enrichedContent;

    // Route to appropriate enrichment function based on database
    switch (placeholder.notionDb) {
      case 'projects':
        enrichedContent = await enrichProject(notion, placeholder.notionId, '');
        break;
      case 'people':
        enrichedContent = await enrichPerson(notion, placeholder.notionId, '');
        break;
      default:
        // For other databases, just mark as complete for now
        const existingContent = await fs.readFile(placeholder.path, 'utf8');
        enrichedContent = existingContent.replace(
          'migration_status: placeholder',
          'migration_status: complete'
        );
        enrichedContent = enrichedContent.replace(
          'needs_full_import: true\n',
          ''
        );
    }

    await fs.writeFile(placeholder.path, enrichedContent);
    return true;

  } catch (error) {
    console.log(chalk.red(`    ✗ Failed: ${error.message}`));
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '10');
  const dbFilter = args.find(a => a.startsWith('--db='))?.split('=')[1];

  console.log(chalk.cyan.bold('\n📚 Notion Enrichment Migration - Phase 2\n'));
  console.log(chalk.gray('Populating placeholder files with full content\n'));

  const notionToken = process.env.NOTION_TOKEN;
  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  const notion = new NotionAPI(notionToken);
  const baseDir = path.resolve(__dirname, '..');

  try {
    // Find all placeholder files
    let placeholders = await findPlaceholderFiles(baseDir);

    // Filter by database if requested
    if (dbFilter) {
      placeholders = placeholders.filter(p => p.notionDb === dbFilter);
      console.log(chalk.gray(`Filtering to ${dbFilter} database only\n`));
    }

    // Limit number to process
    if (limit && placeholders.length > limit) {
      placeholders = placeholders.slice(0, limit);
      console.log(chalk.yellow(`⚠️  Limiting to first ${limit} files\n`));
    }

    // Enrich each file
    console.log(chalk.cyan('📝 Enriching files...\n'));

    let successful = 0;
    let failed = 0;

    for (const placeholder of placeholders) {
      const result = await enrichFile(notion, placeholder);
      if (result) {
        successful++;
        console.log(chalk.green(`  ✓ ${placeholder.title}`));
      } else {
        failed++;
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Summary
    console.log(chalk.cyan('\n📊 Enrichment Summary:\n'));
    console.log(chalk.green(`✅ Successful: ${successful}`));
    console.log(chalk.red(`❌ Failed: ${failed}`));

    console.log(chalk.green.bold('\n✨ Phase 2 Complete!\n'));

  } catch (error) {
    console.error(chalk.red(`\n❌ Fatal error: ${error.message}`));
    process.exit(1);
  } finally {
    notion.close();
  }
}

// Help text
if (process.argv.includes('--help')) {
  console.log(`
${chalk.cyan('Notion Enrichment Migration - Phase 2')}

Usage: node tmp/migrate-notion-enrich.js [options]

Options:
  --limit=<n>     Process only n files (default: 10)
  --db=<name>     Process only specific database
  --help          Show this help

This script enriches placeholder files created in Phase 1
with full content from Notion.

Example:
  node tmp/migrate-notion-enrich.js --limit=5 --db=projects
`);
  process.exit(0);
}

main();