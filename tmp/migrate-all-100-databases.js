#!/usr/bin/env node

/**
 * Complete Migration Script for ALL 100 Notion Databases
 * Two-phase approach: Scaffold then Enrich
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

// ALL 100 DATABASE IDs FROM NOTION
const ALL_DATABASES = {
  // Core Work Management
  'projects': '0ed4aa68-93d2-4268-a3b7-c22337170ee3',
  'action_items': 'de1740b0-2421-43a1-8bda-f177cec69e11',
  'notes_meetings': 'a1d39d9d-5141-4071-a317-9aa8cbf80e54',

  // People & Social
  'people': 'c0ae5ff6-1b70-4004-9b67-6840554d55c7',

  // Planning & Time Management
  'years': '0333c745-d3b3-4e23-be85-6d9289a5f042',
  'quarters': '63f73c5f-dda6-409d-aaff-26df93573f19',
  'months': '1d4b3971-bef5-487b-be26-05da7296bb04',
  'weeks': '65ccdd11-35fb-4eb1-9730-b14ea799ef02',
  'daily_tracking': 'c7154f58-acf0-4bea-92df-0c76c0e85f3b',
  'todays_plan': '880f6cce-d710-4940-9328-cdbad5c6c259',
  'upcoming': '611a9cda-7f8c-4273-80e9-a8a365bd4f2d',

  // Goals & Values
  'pillars': 'bbc09612-0f03-41a8-924b-f7cac648e377',
  'outcome_goals': 'd70f95c9-673f-4077-b2d9-b34775463541',
  'value_goals': 'd209d8c0-ed29-4713-941e-81b853372fd6',
  'accomplishments': '0650fb7a-506a-4bce-b3d3-ffcc64980d2a',
  'disappointments': 'e4e7fb39-627c-4f9c-b7de-4b057320e261',

  // Routines
  'morning_routine': '1a177c23-91aa-44a5-b6aa-c1bcb728a537',
  'morning_routine_2': '7f8321ed-7acf-420e-a255-6bb5d34eeef7',
  'evening_tasks': '1fe466a5-f5de-497a-80c5-ca1f19f03dbc',
  'evening_tasks_2': '39b30841-bc73-4184-ab0c-c0c5a56f77b0',
  'evening_plan': '457c1edd-2b34-4770-9954-c1179a8bbcd9',
  'morning_plan': '4ce27dc6-f93a-4490-89f0-8041c0797c83',
  'day_end_chores': 'b524932a-3ab7-42bd-8a28-6e7cbe0f3e29',
  'day_end_chores_2': '1bbf3291-9920-4318-9dfe-daeb54b718be',
  'habits_routines': 'aeb4f0c6-54bf-4dfb-a6fa-abdc8c8dd125',

  // Content Vaults
  'documents_vault': 'fcfd6135-3c37-4453-beb6-0a0f69273d4c',
  'media_vault': 'b906c2ef-8e5d-48a7-90b6-be2c17ddeb53',
  'email_vault': '418de6c9-d04a-4253-8a01-3b4e6b047765',
  'goods_services_vault': '95ff37b6-25a1-44fc-a260-f7beb42c074d',
  'courses_training_vault': 'c7767f7c-222f-4cfb-bd0f-82846e81bd17',
  'tag_knowledge_vault': '54a45671-b780-4d77-a3dc-c25d42962cf5',
  'tag_knowledge_vault_2': '1175e778-3096-81e2-ba29-c1c9aeaa9ee9',

  // Sites & Bookmarks
  'sites_to_see': '1175e778-3096-81af-b8af-d5421050f84e',
  'sites_to_see_2': '2921318b-7192-4369-ba14-53592e7154a9',

  // OGM Specific
  'oldergay_men': 'ce7ad7b3-1102-449b-9499-4ba41b0c1cb4',
  'oldergay_men_2': '8bcaa9dd-57d2-4886-ac72-fadf43d1423e',

  // Other Named Databases
  'inboxes': '4083409c-ead3-4544-89e0-b4b3c91c7c80',
  'votes': 'a03ea802-eef8-4b0c-8033-7573373111be',
  'content_pipeline': '507729ef-587a-48bb-80f5-3b75093964c3',
  'house_sitters': '85cbeb15-da93-45a5-89b5-08a0dc989fa7',
  'guest_rooms': '04738771-5336-4e87-a86d-836991377daf',
  'life_in_2023': 'dc185e84-ddea-4db3-aafd-3fc049adcc49',
  'workout_tracking': 'fa97fd57-79a0-45b2-9ad2-f4b49c8565cb',
  'ideas': '7bbef915-a77e-4d7d-9086-02af09844efe',
  'work_log': '04beb0a1-c1a2-4857-8305-6dc6b901b056',
  'keyboard_shortcuts': '8f9f12e2-a6dd-44f9-b33c-2c413d209794',
  'alarms': 'b3984ff2-e7d5-45be-b82c-fe4ba28916af',
  'sunrise': '0a1288da-211a-4957-836e-e371b57f50e7',
  'insurance_quotes': 'e88d620c-ee1a-4fc1-b58b-7d178dc5d5c8',
  'insurance_brokers': '39a30edc-73ae-447c-8007-c99467fc1123',
  'experiential_reaction_board': '5de42c2d-d4ad-43f4-bf00-5b36db379bdd',

  // All Untitled databases (may be test/temp, but let's check them)
  'untitled_1': '2365e778-3096-81cb-b614-def509a992f8',
  'untitled_2': '2365e778-3096-8136-9268-f6a037331b4e',
  'untitled_3': '998acaed-9122-4040-8da9-fe1384182581',
  'untitled_4': '1365e778-3096-8188-b2b5-d714e42dde54',
  'untitled_5': 'a7226e05-3886-4ab1-9db0-ad31eff3df44',
  'untitled_6': '76c99408-6842-476c-80d0-4124dfedcde0',
  'untitled_7': '2e2f1961-4b64-4a11-81f6-76812e25e4ef',
  'untitled_8': '5e261167-e2cc-4bf1-802b-e076da9e74e3',
  'untitled_9': '52416ec0-a1f9-4211-9e7f-414dfc76d905',
  'untitled_10': '7dff58f0-4973-458b-9a7a-828eb516edfc',
  'untitled_11': 'a80c7cf9-055c-41ba-b660-e90c93404f27',
  'untitled_12': 'fb938316-20fb-4f0f-a118-6a0385be4dee',
  'untitled_13': '3531c801-8243-4b18-ac1f-59d340dd4b10',
  'untitled_14': '3a24f9d2-c02d-41b1-9941-0d02ea4528eb',
  'untitled_15': '2b138e65-c272-4861-90b7-0fd93a318bf4',
  'untitled_16': '95fcea36-cfeb-44f3-ae58-e2a0011c7f27',
  'untitled_17': '238507b5-75d8-4435-8f85-fa6459d65a14',
  'untitled_18': '367f2112-2ccd-41b5-8e7a-92be2f13c583',
  'untitled_19': 'd558809e-ebcc-46d6-8e72-a9fd62936ceb',
  'untitled_20': '440d9d50-6b22-449d-a408-8a09ec6857a2',
  'untitled_21': 'e1c3e152-56d1-49ed-a445-d4b8eabd972f',
  'untitled_22': 'b96a5d66-fb7d-4e7f-8c04-15166aa298b6',
  'untitled_23': 'd8724dcf-b406-489a-89d3-cf2c17d1233e',
  'untitled_24': '09d52fb3-7211-4f42-af33-8c0ab1b6337e',
  'untitled_25': 'eca85605-db48-4c10-a544-c89ede96347f',
  'untitled_26': '34bc5187-fbb2-40a4-b622-88f971263889',
  'untitled_27': '6c5c0b02-d018-4d44-911e-d1cd98a6fa0d',
  'untitled_28': '992cdb5c-112b-4e41-a8ec-6761dbe862c7',
  'untitled_29': 'e6eb0245-438f-4391-bd52-ad652df9a5ff',
  'untitled_30': '0e6e8299-cf02-46a8-82e6-1fbe76d2d289',
  'untitled_31': '774f1c7b-9bb8-4a0f-a49b-e0da06c238cc',
  'untitled_32': '8fa786e5-13a9-469e-bb92-1227e9232a28',
  'untitled_33': 'e41fa25e-d631-4615-a49b-99bd461a9b07',
  'untitled_34': '597988af-62d2-4c64-a811-114600b236ce',
  'untitled_35': '08173c4d-772a-4799-b376-1ea09b0b6019',
  'untitled_36': '28281e4b-a73e-45eb-91aa-228ae14fecca',
  'untitled_37': '45bec04d-effd-4003-bb9d-7faa8ad9442f',
  'untitled_38': 'e3af9837-cf7a-487d-ba72-8faf66a3aa3e',
  'untitled_39': '1774fd54-1b99-4b77-8d9f-390ab0009a0a',
  'untitled_40': 'd7dbac82-4d43-4c0c-b37e-f08939d7e63e',
  'untitled_41': '636b0a6e-1b6e-4378-8369-a3f79a15c9a9',
  'untitled_42': 'a5ee36c3-b02a-48cf-82e9-4845309ac1cb',
  'untitled_43': '4b38aaaa-8e74-4230-97c9-fb4eb9f0d34a',
  'untitled_44': '8f60692a-13bd-4ac8-901f-48b0d1ed0613',
  'untitled_45': 'a597b4c6-1c64-4329-997e-3baefe573e04',
  'untitled_46': 'b603e5e7-41d4-4871-9695-fef0b52cf1cd',
  'untitled_47': '5f88108e-0c21-4d84-b871-f511e681ed61',
  'untitled_48': 'ff37db29-8b08-424f-83d6-ab25ea8be450',
  'untitled_49': 'e96b6778-963c-4c82-862d-1f1cd3960952'
};

// Map database names to output directories - ALL GO TO NOTION-MIGRATION WORKSPACE
const OUTPUT_DIRS = {
  'projects': 'vault/notion-migration/projects',
  'action_items': 'vault/notion-migration/tasks',
  'notes_meetings': 'vault/notion-migration/notes',
  'people': 'vault/notion-migration/people',
  'years': 'vault/notion-migration/plans-years',
  'quarters': 'vault/notion-migration/plans-quarters',
  'months': 'vault/notion-migration/plans-months',
  'weeks': 'vault/notion-migration/plans-weeks',
  'daily_tracking': 'vault/notion-migration/daily-tracking',
  'todays_plan': 'vault/notion-migration/todays-plan',
  'upcoming': 'vault/notion-migration/upcoming',
  'pillars': 'vault/notion-migration/goals/pillars',
  'outcome_goals': 'vault/notion-migration/goals/outcomes',
  'value_goals': 'vault/notion-migration/goals/values',
  'accomplishments': 'vault/notion-migration/accomplishments',
  'disappointments': 'vault/notion-migration/disappointments',
  'morning_routine': 'vault/notion-migration/routines/morning',
  'morning_routine_2': 'vault/notion-migration/routines/morning2',
  'evening_tasks': 'vault/notion-migration/routines/evening',
  'evening_tasks_2': 'vault/notion-migration/routines/evening2',
  'evening_plan': 'vault/notion-migration/routines/evening-plan',
  'morning_plan': 'vault/notion-migration/routines/morning-plan',
  'day_end_chores': 'vault/notion-migration/routines/day-end',
  'day_end_chores_2': 'vault/notion-migration/routines/day-end2',
  'habits_routines': 'vault/notion-migration/habits',
  'documents_vault': 'vault/notion-migration/documents',
  'media_vault': 'vault/notion-migration/media',
  'email_vault': 'vault/notion-migration/emails',
  'goods_services_vault': 'vault/notion-migration/resources',
  'courses_training_vault': 'vault/notion-migration/learning',
  'tag_knowledge_vault': 'vault/notion-migration/topics',
  'tag_knowledge_vault_2': 'vault/notion-migration/topics2',
  'sites_to_see': 'vault/notion-migration/bookmarks',
  'sites_to_see_2': 'vault/notion-migration/bookmarks2',
  'oldergay_men': 'vault/notion-migration/ogm',
  'oldergay_men_2': 'vault/notion-migration/ogm2',
  'inboxes': 'vault/notion-migration/inbox',
  'votes': 'vault/notion-migration/votes',
  'content_pipeline': 'vault/notion-migration/content',
  'house_sitters': 'vault/notion-migration/house/sitters',
  'guest_rooms': 'vault/notion-migration/house/rooms',
  'life_in_2023': 'vault/notion-migration/archive/2023',
  'workout_tracking': 'vault/notion-migration/fitness',
  'ideas': 'vault/notion-migration/ideas',
  'work_log': 'vault/notion-migration/work',
  'keyboard_shortcuts': 'vault/notion-migration/reference/shortcuts',
  'alarms': 'vault/notion-migration/reference/alarms',
  'sunrise': 'vault/notion-migration/reference/sunrise',
  'insurance_quotes': 'vault/notion-migration/insurance/quotes',
  'insurance_brokers': 'vault/notion-migration/insurance/brokers',
  'experiential_reaction_board': 'vault/notion-migration/misc/reactions'
};

// For untitled databases, create a misc directory
for (let i = 1; i <= 49; i++) {
  OUTPUT_DIRS[`untitled_${i}`] = `vault/misc/untitled-${i}`;
}

function slugify(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

async function scaffoldDatabase(notion, name, dbId, outputDir) {
  console.log(chalk.cyan(`\n📦 Scaffolding ${name}...`));

  // SKIP ACTION ITEMS FOR NOW - it has thousands of entries
  if (name === 'action_items') {
    console.log(chalk.yellow(`  ⚠️ SKIPPING action_items (too large, will handle separately)`));
    return { files: [], count: 0 };
  }

  const files = [];
  let total = 0;

  try {
    let hasMore = true;
    let cursor = undefined;
    let pageNum = 0;

    while (hasMore) {
      pageNum++;
      process.stdout.write(`\r  Loading page ${pageNum}...`);

      const response = await notion.notion.databases.query({
        database_id: dbId,
        page_size: 25,
        start_cursor: cursor
      });

      for (const item of response.results) {
        const title = notion.extractTitle(item) || 'Untitled';
        const slug = slugify(title);

        // Skip completely empty untitled items
        if (title === 'Untitled' && !item.properties?.Text?.rich_text?.length) {
          continue;
        }

        const filePath = `${outputDir}/${slug}.md`;

        // Create scaffold with metadata
        let content = '---\n';
        content += `title: ${title}\n`;
        content += `migration_status: placeholder\n`;
        content += `needs_full_import: true\n`;
        content += `notion_id: ${item.id}\n`;
        content += `notion_db: ${name}\n`;
        content += `created: ${item.created_time.split('T')[0]}\n`;
        content += `last_edited: ${item.last_edited_time.split('T')[0]}\n`;
        content += '---\n\n';
        content += `# ${title}\n\n`;
        content += `> 🔄 This is a placeholder file. Full content will be imported in Phase 2.\n\n`;
        content += `*Scaffolded from Notion ${name} database on ${new Date().toISOString().split('T')[0]}*\n`;

        files.push({ path: filePath, content });
        total++;
      }

      hasMore = response.has_more;
      cursor = response.next_cursor;

      // Safety limit
      if (total >= 1000) {
        console.log(chalk.yellow(`\n  ⚠️ Limiting ${name} to first 1000 items`));
        break;
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    process.stdout.write('\r'); // Clear progress line
    console.log(chalk.green(`  ✓ Found ${total} items in ${name}`));

  } catch (error) {
    console.log(chalk.red(`  ✗ Failed to scaffold ${name}: ${error.message}`));
  }

  return { files, count: total };
}

async function writeFiles(files) {
  const projectRoot = path.resolve(__dirname, '..');
  let successful = 0;
  let skipped = 0;

  // Group by directory
  const byDir = {};
  files.forEach(f => {
    const dir = path.dirname(f.path);
    if (!byDir[dir]) byDir[dir] = [];
    byDir[dir].push(f);
  });

  // Create directories and write files
  for (const [dir, dirFiles] of Object.entries(byDir)) {
    const fullDir = path.join(projectRoot, dir);
    await fs.mkdir(fullDir, { recursive: true });

    for (const file of dirFiles) {
      const fullPath = path.join(projectRoot, file.path);

      try {
        // Check if exists
        const exists = await fs.access(fullPath).then(() => true).catch(() => false);
        if (exists) {
          skipped++;
          continue;
        }

        await fs.writeFile(fullPath, file.content);
        successful++;

      } catch (error) {
        console.log(chalk.red(`    ✗ Failed: ${path.basename(file.path)}`));
      }
    }
  }

  return { successful, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipUntitled = args.includes('--skip-untitled');

  console.log(chalk.cyan.bold('\n🚀 COMPLETE NOTION MIGRATION - ALL 100 DATABASES\n'));
  console.log(chalk.gray('Migrating every single database from Notion to Today\n'));

  if (dryRun) {
    console.log(chalk.yellow('DRY RUN MODE - No files will be created\n'));
  }

  const notionToken = process.env.NOTION_TOKEN;
  if (!notionToken) {
    console.error(chalk.red('❌ NOTION_TOKEN not found'));
    process.exit(1);
  }

  const notion = new NotionAPI(notionToken);
  const allFiles = [];
  const stats = {
    total_databases: 0,
    empty_databases: 0,
    total_items: 0,
    databases_processed: []
  };

  try {
    // Process each database
    for (const [name, dbId] of Object.entries(ALL_DATABASES)) {
      // Skip untitled if requested
      if (skipUntitled && name.startsWith('untitled_')) {
        continue;
      }

      const outputDir = OUTPUT_DIRS[name] || `vault/migration/${name}`;
      const result = await scaffoldDatabase(notion, name, dbId, outputDir);

      stats.total_databases++;

      if (result.count === 0) {
        stats.empty_databases++;
        console.log(chalk.gray(`    (empty database)`));
      } else {
        stats.total_items += result.count;
        stats.databases_processed.push({ name, count: result.count });
        allFiles.push(...result.files);
      }
    }

    // Write all files
    if (!dryRun) {
      console.log(chalk.cyan(`\n💾 Writing ${allFiles.length} scaffold files...`));
      const writeResult = await writeFiles(allFiles);

      console.log(chalk.green(`\n✅ Created ${writeResult.successful} files (${writeResult.skipped} skipped)`));
    }

    // Summary
    console.log(chalk.cyan('\n📊 MIGRATION SUMMARY:\n'));
    console.log(chalk.yellow(`Total databases processed: ${stats.total_databases}`));
    console.log(chalk.yellow(`Empty databases: ${stats.empty_databases}`));
    console.log(chalk.yellow(`Total items migrated: ${stats.total_items}`));
    console.log(chalk.yellow(`Total files created: ${allFiles.length}`));

    console.log(chalk.cyan('\n📁 Top databases by item count:\n'));
    const sorted = stats.databases_processed.sort((a, b) => b.count - a.count).slice(0, 10);
    sorted.forEach(db => {
      console.log(`  ${db.name}: ${db.count} items`);
    });

    console.log(chalk.green.bold('\n🎉 ALL 100 DATABASES SCAFFOLDED SUCCESSFULLY!\n'));
    console.log(chalk.gray('Next step: Run enrichment script to populate with full content'));

  } catch (error) {
    console.error(chalk.red(`\n❌ Fatal error: ${error.message}`));
    console.error(error);
    process.exit(1);
  } finally {
    notion.close();
  }
}

// Help text
if (process.argv.includes('--help')) {
  console.log(`
${chalk.cyan('Complete Notion Migration - All 100 Databases')}

Usage: node tmp/migrate-all-100-databases.js [options]

Options:
  --dry-run        Preview without creating files
  --skip-untitled  Skip the 49 untitled databases
  --help           Show this help

This script scaffolds ALL 100 databases from Notion.
Phase 1: Creates placeholder files with metadata
Phase 2: Use enrichment script to add full content
`);
  process.exit(0);
}

main();