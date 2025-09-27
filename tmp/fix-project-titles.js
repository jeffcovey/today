#!/usr/bin/env node

/**
 * Fix missing titles in enriched project files
 * Uses filename to restore the title
 */

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';

const PROJECTS_DIR = 'vault/notion-migration/projects';

function filenameToTitle(filename) {
  // Remove .md extension
  const name = filename.replace('.md', '');

  // Convert kebab-case to Title Case
  return name
    .split('-')
    .map(word => {
      // Handle special cases
      if (word === 'ogm') return 'OGM';
      if (word === 'sd') return 'SD';
      if (word === 'og') return 'OG';
      if (word === 'api') return 'API';
      if (word === 'gps') return 'GPS';
      if (word === 'als') return "Al's";
      if (word === 'rons') return "Ron's";
      if (word === 'rameshs') return "Ramesh's";
      if (word === 'dans') return "Dan's";

      // Regular title case
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

async function fixProjectFile(filepath, filename) {
  const content = await fs.readFile(filepath, 'utf-8');

  // Skip if not enriched
  if (!content.includes('migration_status: enriched')) {
    return false;
  }

  // Extract the title from filename
  const title = filenameToTitle(filename);

  // Fix the frontmatter - add title after notion_id
  let fixed = content.replace(
    /^(---\n)(notion_id:.*\n)/m,
    `$1$2title: "${title}"\n`
  );

  // Fix the empty heading
  fixed = fixed.replace(/^# \s*$/m, `# ${title}`);

  // Write back
  await fs.writeFile(filepath, fixed, 'utf-8');
  return true;
}

async function main() {
  console.log(chalk.cyan.bold('\n🔧 Fixing Project Titles\n'));

  try {
    const files = await fs.readdir(PROJECTS_DIR);
    const projectFiles = files.filter(f => f.endsWith('.md'));

    let fixed = 0;
    let skipped = 0;

    for (const filename of projectFiles) {
      const filepath = path.join(PROJECTS_DIR, filename);
      process.stdout.write(`  Fixing ${filename}...`);

      const wasFixed = await fixProjectFile(filepath, filename);
      if (wasFixed) {
        console.log(chalk.green(' ✓'));
        fixed++;
      } else {
        console.log(chalk.gray(' (skipped)'));
        skipped++;
      }
    }

    console.log(chalk.cyan('\n📊 Summary:\n'));
    console.log(chalk.green(`  ✅ Fixed: ${fixed}`));
    console.log(chalk.yellow(`  ⏭️  Skipped: ${skipped}`));

  } catch (error) {
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    process.exit(1);
  }
}

main();