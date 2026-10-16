#!/usr/bin/env node

/**
 * Append a role-agent report to today's daily plan as a durable ROLE: block.
 *
 *   plugins/roles/report.js <role> "report text"
 *   echo "report text" | plugins/roles/report.js <role> --status ok
 *   plugins/roles/report.js <role> --check "item text"     # flip - [ ] to - [x]
 *   plugins/roles/report.js <role> --cancel "item text"    # flip - [ ] to - [-]
 *   plugins/roles/report.js <role> --date 2026-10-15 --amend 16:10 "corrected text"
 *
 * Role agents must use this instead of editing plan files by hand: it
 * validates the report (length cap, no marker injection), appends inside
 * the role's block without touching existing content (so user replies
 * survive), and writes atomically.
 */

import fs from 'fs';
import path from 'path';
import { program } from 'commander';
import { getAbsoluteVaultPath } from '../../src/config.js';
import { colors } from '../../src/cli-utils.js';
import { appendRoleReport, amendRoleEntry, setRoleCheckboxState, rolesPluginEnabled, ROLE_STATUSES, MAX_REPORT_LENGTH } from './block-writer.js';
import { minimalDailyPlan, rolePlanFile, todayDateString } from './plan-file.js';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function collect(value, previous) {
  return previous.concat([value]);
}

program
  .name('plugins/roles/report.js')
  .description(`Append a role-agent report to the day's plan file (max ${MAX_REPORT_LENGTH} chars). Reads the report from the argument or stdin.`)
  .argument('<role>', 'role name (lowercase letters, digits, hyphens)')
  .argument('[message]', 'report text (omit to read from stdin)')
  .option('--status <status>', `status line: ${ROLE_STATUSES.join(', ')}`)
  .option('--title <title>', 'display heading used when the block is first created')
  .option('--date <date>', 'plan date (YYYY-MM-DD, default: today)')
  .option('--check <text>', 'flip a matching open checkbox in your block to done ([x]); repeatable', collect, [])
  .option('--cancel <text>', 'flip a matching open checkbox in your block to cancelled ([-]); repeatable', collect, [])
  .option('--amend <time>', 'replace the text of your own earlier entry (### HH:MM) in place instead of appending; user replies and settled checkboxes in it are kept')
  .action(async (role, message, options) => {
    if (!rolesPluginEnabled()) {
      console.error(colors.red('✗') + ' The roles plugin is not enabled; enable [plugins.roles.<source>] in your config to use role reports.');
      process.exit(1);
    }

    const flips = [
      ...options.check.map((text) => ({ text, state: 'x', label: 'Checked' })),
      ...options.cancel.map((text) => ({ text, state: '-', label: 'Cancelled' }))
    ];
    // A flips-only call (no message argument) must not block on stdin;
    // to flip and report in one call, pass the report as an argument.
    const text = message !== undefined ? message : flips.length > 0 ? '' : await readStdin();

    const date = options.date || todayDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error(colors.red('✗') + ` Invalid date "${options.date}": expected YYYY-MM-DD`);
      process.exit(1);
    }

    const filePath = rolePlanFile(getAbsoluteVaultPath(), date);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    for (const flip of flips) {
      const flipResult = setRoleCheckboxState(filePath, role, flip.text, flip.state);
      if (!flipResult.ok) {
        console.error(colors.red('✗') + ` ${flipResult.error}`);
        process.exit(1);
      }
      console.log(colors.green('✓') + ` ${flip.label}: ${flipResult.line}`);
    }

    if (!text.trim()) {
      if (flips.length > 0) {
        return;
      }
      console.error(colors.red('✗') + ' Report text is empty');
      process.exit(1);
    }

    if (options.amend) {
      const amended = amendRoleEntry(filePath, role, options.amend, text, { status: options.status });
      if (!amended.ok) {
        console.error(colors.red('✗') + ` ${amended.error}`);
        process.exit(1);
      }
      const kept = [
        amended.replies > 0 ? `${amended.replies} user ${amended.replies === 1 ? 'reply' : 'replies'}` : null,
        amended.settled > 0 ? `${amended.settled} settled ${amended.settled === 1 ? 'checkbox' : 'checkboxes'}` : null
      ].filter(Boolean);
      const keptSuffix = kept.length > 0 ? ` (kept ${kept.join(' and ')})` : '';
      console.log(colors.green('✓') + ` Amended ${role} entry ${amended.line} in ${filePath}${keptSuffix}`);
      return;
    }

    const result = appendRoleReport(filePath, role, text, {
      status: options.status,
      title: options.title,
      initialContent: minimalDailyPlan(date)
    });

    if (!result.ok) {
      console.error(colors.red('✗') + ` ${result.error}`);
      process.exit(1);
    }

    const extras = [
      result.createdFile ? 'created plan file' : null,
      result.createdBlock ? 'created role block' : null
    ].filter(Boolean);
    const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
    console.log(colors.green('✓') + ` Added ${role} report to ${filePath}${suffix}`);
  });

program.parse();
