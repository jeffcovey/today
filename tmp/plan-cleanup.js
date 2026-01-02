#!/usr/bin/env node

/**
 * Plan File Cleanup
 *
 * NOTE: This was extracted from bin/sync for migration to a standalone script.
 *
 * Functions:
 * - cancelOldPlanTasks: Clean up routine sections in old plan files
 * - generateDailySummary: Generate AI summary for a day
 * - generateWeeklySummary: Generate AI summary for a week
 * - processRoutineSections: Process routine sections in a plan file
 * - processSection: Process a single routine section
 * - cleanPlanFileTasks: Remove date/recurrence properties from tasks in plan files
 *
 * CLI commands this supported:
 * - bin/sync --cancel-old-plan-tasks [FILE]
 * - bin/sync --generate-weekly-summary FILE
 */

import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  formatDate,
  getWeekNumber,
  getQuarterNumber,
  addDaysToDate,
} from '../src/date-utils.js';
import {
  colors,
  printStatus,
  printError,
  printInfo,
  printWarning,
  printHeader,
} from '../src/cli-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

process.chdir(projectRoot);

/**
 * Clean up routine sections in old plan files
 */
async function cancelOldPlanTasks(specificFile = null) {
  printInfo(specificFile ? `Processing specific file: ${specificFile}` : 'Checking for old plan files to clean up...');

  const today = formatDate(new Date());
  const weekAgoDate = formatDate(addDaysToDate(new Date(), -7));

  let planFiles = [];
  if (specificFile) {
    planFiles = [specificFile];
  } else {
    try {
      const result = execSync(
        'find vault/plans -type f -name "2*_Q*_*_W*_*.md" 2>/dev/null | sort',
        { encoding: 'utf8' }
      );
      planFiles = result.trim().split('\n').filter(Boolean);
    } catch {
      printInfo('No plan files found');
      return true;
    }
  }

  if (planFiles.length === 0) {
    printInfo('No plan files found');
    return true;
  }

  let modifiedFiles = 0;

  for (const file of planFiles) {
    const basename = path.basename(file, '.md');
    const match = basename.match(/^(\d{4})_Q\d_(\d{2})_W\d+_(\d{2})$/);

    if (!match) continue;

    const [, year, month, day] = match;
    const fileDate = `${year}-${month}-${day}`;

    if (!specificFile && fileDate >= today) continue;
    if (!specificFile && fileDate < weekAgoDate) continue;

    if (await processRoutineSections(file, fileDate)) {
      modifiedFiles++;
    }
  }

  if (modifiedFiles > 0) {
    printInfo(`Cleaned up ${modifiedFiles} old plan file(s)`);
  } else {
    printInfo('No plan files needed cleanup');
  }

  return true;
}

/**
 * Generate a daily summary using AI
 */
async function generateDailySummary(fileDate, filePath) {
  try {
    let apiKey = '';
    try {
      apiKey = execSync('npx dotenvx get TODAY_ANTHROPIC_KEY', { encoding: 'utf8' }).trim();
    } catch (e) {
      printWarning('No API key found for AI summary generation - skipping');
      return '';
    }

    if (!apiKey || apiKey.includes('not set')) {
      printWarning('No API key found for AI summary generation - skipping');
      return '';
    }

    const dataSources = [];

    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      dataSources.push(`DAILY PLAN FILE:\n${fileContent}`);
    }

    try {
      const timeTracking = execSync(`bin/db-query custom "
        SELECT start_time, end_time, duration_minutes, description FROM time_logs
        WHERE date(start_time) = '${fileDate}'
        ORDER BY start_time
      "`, { encoding: 'utf8' });
      const timeData = JSON.parse(timeTracking);
      if (timeData && timeData.length > 0) {
        const formatted = timeData.map(e => {
          const mins = e.duration_minutes || 0;
          return `${e.start_time.substring(11, 16)} (${mins}m): ${e.description}`;
        }).join('\n');
        dataSources.push(`TIME TRACKING:\n${formatted}`);
      }
    } catch (e) { }

    try {
      const eventsQuery = execSync(`bin/db-query custom "
        SELECT title, start_date, end_date, location FROM calendar_events
        WHERE date(start_date) = '${fileDate}'
        ORDER BY start_date
      "`, { encoding: 'utf8' });
      const eventsData = JSON.parse(eventsQuery);
      if (eventsData && eventsData.length > 0) {
        dataSources.push(`CALENDAR EVENTS:\n${JSON.stringify(eventsData, null, 2)}`);
      }
    } catch (e) { }

    try {
      const diaryQuery = execSync(`bin/db-query custom "
        SELECT text FROM diary
        WHERE date(creation_date) = '${fileDate}'
        ORDER BY creation_date DESC
        LIMIT 1
      "`, { encoding: 'utf8' });
      const diaryData = JSON.parse(diaryQuery);
      if (diaryData && diaryData.length > 0) {
        dataSources.push(`DIARY ENTRY:\n${diaryData[0].text}`);
      }
    } catch (e) { }

    if (dataSources.length === 0) {
      return 'No activity recorded this day';
    }

    const prompt = `You are summarizing a day (${fileDate}) for a daily planning system. Review all the data below and write a 2-3 sentence narrative summary that captures:
- What was accomplished (major wins, completed tasks)
- The overall theme or focus of the day
- Any notable challenges or insights

Be qualitative and narrative, not just a list. Make it meaningful and readable.

${dataSources.join('\n\n---\n\n')}

Write ONLY the 2-3 sentence summary, nothing else:`;

    const tempPromptFile = `/tmp/summary-prompt-${Date.now()}.txt`;
    fs.writeFileSync(tempPromptFile, prompt);

    let model = 'claude-haiku-4-5-20251001';
    try {
      const configModel = execSync('bin/get-config ai.claude_model 2>/dev/null', { encoding: 'utf8' }).trim();
      if (configModel) model = configModel;
    } catch { }
    if (process.env.CLAUDE_MODEL) model = process.env.CLAUDE_MODEL;

    const response = execSync(
      `npx dotenvx run --quiet -- node -e "const Anthropic = require('@anthropic-ai/sdk'); const fs = require('fs'); const client = new Anthropic({ apiKey: process.env.TODAY_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY }); (async () => { const prompt = fs.readFileSync('${tempPromptFile}', 'utf-8'); const response = await client.messages.create({ model: '${model}', max_tokens: 300, temperature: 0.7, messages: [{ role: 'user', content: prompt }] }); console.log(response.content[0].text.trim()); })();"`,
      { encoding: 'utf8', timeout: 30000 }
    );

    fs.unlinkSync(tempPromptFile);
    return response.trim();
  } catch (error) {
    printWarning(`Failed to generate AI summary for ${fileDate}: ${error.message}`);
    return '';
  }
}

/**
 * Generate a weekly summary using AI
 */
async function generateWeeklySummary(weekFilePath) {
  try {
    let apiKey = '';
    try {
      apiKey = execSync('npx dotenvx get TODAY_ANTHROPIC_KEY', { encoding: 'utf8' }).trim();
    } catch (e) {
      printWarning('No API key found for AI weekly summary generation - skipping');
      return '';
    }

    if (!apiKey || apiKey.includes('not set')) {
      printWarning('No API key found for AI weekly summary generation - skipping');
      return '';
    }

    const weekContent = fs.readFileSync(weekFilePath, 'utf-8');
    const frontmatterMatch = weekContent.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      printWarning('Could not find frontmatter in weekly file');
      return '';
    }

    const frontmatter = frontmatterMatch[1];

    const dayFileNames = [];
    const dayMatches = frontmatter.matchAll(/(?:mon|tue|wed|thu|fri|sat|sun)_file:\s*(.+)/g);
    for (const match of dayMatches) {
      if (match[1] && match[1].trim()) {
        dayFileNames.push(match[1].trim());
      }
    }

    if (dayFileNames.length === 0) {
      printWarning('No daily files found in weekly review frontmatter');
      return '';
    }

    const dailySummaries = [];
    for (const dayFileName of dayFileNames) {
      const fileName = dayFileName.endsWith('.md') ? dayFileName : `${dayFileName}.md`;
      const dayFilePath = `vault/plans/${fileName}`;
      if (fs.existsSync(dayFilePath)) {
        const dayContent = fs.readFileSync(dayFilePath, 'utf-8');
        const dayFrontmatterMatch = dayContent.match(/^---\n([\s\S]*?)\n---/);
        if (dayFrontmatterMatch) {
          const dayFrontmatter = dayFrontmatterMatch[1];
          const summaryMatch = dayFrontmatter.match(/daily_summary:\s*"?([^"\n]+)"?/);
          if (summaryMatch && summaryMatch[1] && summaryMatch[1].trim()) {
            const dateMatch = fileName.match(/_(\d{2})\.md$/);
            const day = dateMatch ? dateMatch[1] : '??';
            dailySummaries.push(`**Day ${day}:** ${summaryMatch[1].trim()}`);
          }
        }
      }
    }

    if (dailySummaries.length === 0) {
      return 'No daily summaries available for this week';
    }

    const weekNumMatch = frontmatter.match(/week_number:\s*(.+)/);
    const weekThemeMatch = frontmatter.match(/weekly_theme:\s*(.+)/);
    const startDateMatch = frontmatter.match(/start_date:\s*(.+)/);
    const endDateMatch = frontmatter.match(/end_date:\s*(.+)/);

    const weekNum = weekNumMatch ? weekNumMatch[1].trim() : '??';
    const weekTheme = weekThemeMatch ? weekThemeMatch[1].trim() : '';
    const startDate = startDateMatch ? startDateMatch[1].trim() : '';
    const endDate = endDateMatch ? endDateMatch[1].trim() : '';

    const prompt = `You are summarizing Week ${weekNum} (${startDate} to ${endDate}) for a weekly planning review${weekTheme ? `, which had the theme: "${weekTheme}"` : ''}.

Review all the daily summaries below and write a 3-4 sentence narrative summary that captures:
- The overall arc and narrative of the week
- Major themes, patterns, or shifts that emerged across the days
- Key accomplishments and how they built on each other
- Any important lessons or insights from how the week unfolded

Write in a direct, straightforward style. Avoid flowery language, superlatives, or overly dramatic phrasing like "masterclass", "crescendo", or "epic". Be honest and factual about what happened, not fawning or grandiose.

DAILY SUMMARIES:
${dailySummaries.join('\n\n')}

Write ONLY the 3-4 sentence weekly summary, nothing else:`;

    const tempPromptFile = `/tmp/weekly-summary-prompt-${Date.now()}.txt`;
    fs.writeFileSync(tempPromptFile, prompt);

    let model = 'claude-haiku-4-5-20251001';
    try {
      const configModel = execSync('bin/get-config ai.claude_model 2>/dev/null', { encoding: 'utf8' }).trim();
      if (configModel) model = configModel;
    } catch { }
    if (process.env.CLAUDE_MODEL) model = process.env.CLAUDE_MODEL;

    const response = execSync(
      `npx dotenvx run --quiet -- node -e "const Anthropic = require('@anthropic-ai/sdk'); const fs = require('fs'); const client = new Anthropic({ apiKey: process.env.TODAY_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY }); (async () => { const prompt = fs.readFileSync('${tempPromptFile}', 'utf-8'); const response = await client.messages.create({ model: '${model}', max_tokens: 500, temperature: 0.7, messages: [{ role: 'user', content: prompt }] }); console.log(response.content[0].text.trim()); })();"`,
      { encoding: 'utf8', timeout: 30000 }
    );

    fs.unlinkSync(tempPromptFile);
    return response.trim();
  } catch (error) {
    printWarning(`Failed to generate AI weekly summary: ${error.message}`);
    return '';
  }
}

/**
 * Process routine sections in a single plan file
 */
async function processRoutineSections(filePath, fileDate) {
  let content = fs.readFileSync(filePath, 'utf-8');
  let modified = false;

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    if (!frontmatter.match(/daily_summary:\s*.+/) || frontmatter.match(/daily_summary:\s*$/m)) {
      const summary = await generateDailySummary(fileDate, filePath);
      if (summary) {
        const escapedSummary = summary.replace(/"/g, '\\"');
        content = content.replace(
          /daily_summary:\s*$/m,
          `daily_summary: "${escapedSummary}"`
        );
        modified = true;
        printInfo(`  Added daily summary for ${fileDate}`);
      }
    }
  }

  const sections = [
    { regex: /> \[!info\]-?\s*🌅 Morning Routine([\s\S]*?)(?=\n(?:>\s*\[!|###|##)|$)/i, name: '🌅 Morning Routine', type: 'info' },
    { regex: /> \[!tip\]-?\s*🏃 Hip Mobility Workout \(45 minutes\)([\s\S]*?)(?=\n(?:>\s*\[!|###|##)|$)/i, name: '🏃 Hip Mobility Workout (45 minutes)', type: 'tip' },
    { regex: /> \[!warning\]-?\s*🌄 Evening Routine([\s\S]*?)(?=\n(?:>\s*\[!|###|##)|$)/i, name: '🌄 Evening Routine', type: 'warning' }
  ];

  for (const section of sections) {
    const result = processSection(content, section.regex, section.name, section.type);
    if (result.modified) {
      content = result.content;
      modified = true;
    }
  }

  const completedTodayMarker = /<!-- COMPLETED_TODAY:.*?-->\n## ✅ Completed Today[\s\S]*?```tasks\n\s*done today\n/;
  if (content.match(completedTodayMarker)) {
    content = content.replace(
      completedTodayMarker,
      `<!-- COMPLETED_TODAY: Auto-updated with specific date after day completes -->\n## ✅ Completed Today\n\n- ✅ Completed Tasks\n\n  \`\`\`tasks\n  done on ${fileDate}\n`
    );
    modified = true;
  } else {
    const dateRegex = /## ✅ Completed Today\n\n- ✅ Completed Tasks\n\n\s*```tasks\n\s*done today\n/;
    if (content.match(dateRegex)) {
      content = content.replace(
        dateRegex,
        `## ✅ Completed Today\n\n- ✅ Completed Tasks\n\n  \`\`\`tasks\n  done on ${fileDate}\n`
      );
      modified = true;
    }
  }

  const dueScheduledMarker = /<!-- DUE_TODAY:.*?-->[\s\S]*?<!-- \/DUE_TODAY -->\n*/g;
  if (content.match(dueScheduledMarker)) {
    content = content.replace(dueScheduledMarker, '');
    modified = true;
  } else {
    const dueScheduledRegex = /> \[!note\]-?\s*📅 Due or Scheduled Today\n>\n> ```tasks\n> not done\n> \(scheduled before tomorrow\) OR \(due before tomorrow\)\n> sort by priority\n> group by happens\n> ```\n*/;
    if (content.match(dueScheduledRegex)) {
      content = content.replace(dueScheduledRegex, '');
      modified = true;
    }
  }

  const draftPlanRegex = /> \[!info\] Draft Plan\n> This is a preliminary plan.*\n\n/;
  if (content.match(draftPlanRegex)) {
    content = content.replace(draftPlanRegex, '');
    modified = true;
  }

  const dailyScheduleMarker = /<!-- DAILY_SCHEDULE:.*?-->[\s\S]*?<!-- \/DAILY_SCHEDULE -->\n*/g;
  if (content.match(dailyScheduleMarker)) {
    content = content.replace(dailyScheduleMarker, '');
    modified = true;
  }

  const lines = content.split('\n');
  const filteredLines = [];
  let inTimeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.match(/^### (?:Morning|Afternoon|Evening)(?:\s|$)/)) {
      inTimeBlock = true;
      modified = true;
      continue;
    }

    if (inTimeBlock && (line.match(/^##[^#]/) || line.match(/^> \[!/))) {
      inTimeBlock = false;
      filteredLines.push(line);
      continue;
    }

    if (inTimeBlock) continue;

    filteredLines.push(line);
  }

  if (modified) {
    content = filteredLines.join('\n');
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Process a single routine section
 */
function processSection(content, sectionRegex, sectionName, calloutType) {
  const match = content.match(sectionRegex);
  if (!match) {
    return { content, modified: false };
  }

  const sectionContent = match[1];

  if (sectionContent.includes('**Undone:**')) {
    return { content, modified: false };
  }

  const lines = sectionContent.split('\n');

  let totalTasks = 0;
  let completedTasks = 0;
  const undoneTasks = [];

  for (const line of lines) {
    if (line.match(/^>\s*-\s*\[./)) {
      totalTasks++;
      if (line.match(/^>\s*-\s*\[x\]/i)) {
        completedTasks++;
      } else {
        const taskText = line.replace(/^>\s*-\s*\[.\]\s*/, '').trim();
        if (taskText) {
          undoneTasks.push(taskText);
        }
      }
    }
  }

  if (totalTasks === 0) {
    return { content, modified: false };
  }

  const percentage = Math.round((completedTasks / totalTasks) * 100);

  let newSection = `> [!${calloutType}] ${sectionName} (${percentage}% done)\n`;

  if (undoneTasks.length > 0) {
    newSection += `>\n> **Undone:**\n>\n`;
    for (const task of undoneTasks) {
      newSection += `> - ${task}\n`;
    }
  } else {
    newSection += `>\n> All tasks completed! ✅\n`;
  }

  content = content.replace(sectionRegex, newSection);
  return { content, modified: true };
}

/**
 * Clean tasks in plan files (removing date/recurrence properties)
 */
async function cleanPlanFileTasks() {
  printInfo('Cleaning tasks in plan files (removing date/recurrence properties)...');

  try {
    const result = execSync(
      'find vault/plans -type f -name "*.md" 2>/dev/null',
      { encoding: 'utf8' }
    );

    const planFiles = result.trim().split('\n').filter(Boolean);
    if (planFiles.length === 0) {
      printInfo('No plan files found');
      return true;
    }

    let cleanedCount = 0;
    let taskCount = 0;

    for (const file of planFiles) {
      const content = fs.readFileSync(file, 'utf-8');

      if (/^\s*-\s*\[[x ]\].*[📅⏳🔁]/m.test(content)) {
        const lines = content.split('\n');
        let modified = false;

        const cleanedLines = lines.map(line => {
          if (/^\s*-\s*\[[x ]\].*[📅⏳🔁]/.test(line)) {
            taskCount++;
            modified = true;
            return line
              .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
              .replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, '')
              .replace(/🔁\s*every\s+[a-zA-Z0-9 ,]+/g, '')
              .replace(/\s+/g, ' ')
              .replace(/\s+$/, '');
          }
          return line;
        });

        if (modified) {
          fs.writeFileSync(file, cleanedLines.join('\n'), 'utf-8');
          cleanedCount++;
        }
      }
    }

    if (cleanedCount > 0) {
      printInfo(`Cleaned ${taskCount} task(s) in ${cleanedCount} plan file(s)`);
    } else {
      printInfo('No tasks with date/recurrence properties found in plan files');
    }

    return true;
  } catch (error) {
    printError(`Failed to clean plan files: ${error.message}`);
    return false;
  }
}

// CLI
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'cancel-old':
  case '--cancel-old-plan-tasks':
    printHeader('🗓️ Cancel Old Plan Tasks');
    cancelOldPlanTasks(args[1])
      .then(() => {
        printStatus('Old plan tasks processed successfully!');
        process.exit(0);
      })
      .catch((error) => {
        printError(`Failed: ${error.message}`);
        process.exit(1);
      });
    break;

  case 'weekly-summary':
  case '--generate-weekly-summary':
    printHeader('📊 Generate Weekly Summary');
    if (!args[1]) {
      printError('Please provide a weekly review file path');
      console.log('Usage: plan-cleanup weekly-summary vault/plans/YYYY_Q#_MM_W##.md');
      process.exit(1);
    }
    (async () => {
      try {
        const weekFile = args[1];
        let content = fs.readFileSync(weekFile, 'utf-8');
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) {
          printError('Could not find frontmatter in weekly file');
          process.exit(1);
        }

        const frontmatter = frontmatterMatch[1];

        if (!frontmatter.includes('weekly_summary:')) {
          content = content.replace(
            /cssclasses: plan\n---/,
            'weekly_summary:\ncssclasses: plan\n---'
          );
          fs.writeFileSync(weekFile, content);
          printInfo('  Added weekly_summary field to frontmatter');
          content = fs.readFileSync(weekFile, 'utf-8');
        }

        const updatedFrontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (updatedFrontmatterMatch && updatedFrontmatterMatch[1].match(/weekly_summary:[ \t]+[^\n]+/)) {
          printInfo('Weekly summary already exists - skipping');
          process.exit(0);
        }

        const summary = await generateWeeklySummary(weekFile);
        if (summary) {
          content = fs.readFileSync(weekFile, 'utf-8');
          const escapedSummary = summary.replace(/"/g, '\\"');
          content = content.replace(
            /weekly_summary:\s*$/m,
            `weekly_summary: "${escapedSummary}"`
          );
          fs.writeFileSync(weekFile, content);
          printStatus('Weekly summary generated successfully!');
          console.log('');
          console.log(colors.gray('Summary:'));
          console.log(summary);
        } else {
          printWarning('No summary generated');
        }
        process.exit(0);
      } catch (error) {
        printError(`Failed: ${error.message}`);
        process.exit(1);
      }
    })();
    break;

  case 'clean-tasks':
    printHeader('📋 Clean Plan Tasks');
    cleanPlanFileTasks()
      .then(() => {
        printStatus('Plan tasks cleaned!');
        process.exit(0);
      })
      .catch((error) => {
        printError(`Failed: ${error.message}`);
        process.exit(1);
      });
    break;

  case 'help':
  case '--help':
  default:
    console.log(`Plan Cleanup - Extract from bin/sync

Usage:
  plan-cleanup cancel-old [FILE]     Clean up old plan files
  plan-cleanup weekly-summary FILE   Generate weekly summary
  plan-cleanup clean-tasks           Remove date/recurrence from tasks
  plan-cleanup help                  Show this help
`);
    break;
}

export { cancelOldPlanTasks, generateDailySummary, generateWeeklySummary, cleanPlanFileTasks };
