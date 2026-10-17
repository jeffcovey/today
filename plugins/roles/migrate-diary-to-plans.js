#!/usr/bin/env node

/**
 * One-off: move ROLE blocks (and the replies inside them) out of the diary
 * files into the daily plan of the same date, where roles report now.
 *
 *   plugins/roles/migrate-diary-to-plans.js            # dry run: writes nothing, prints diffs
 *   plugins/roles/migrate-diary-to-plans.js --write    # move the blocks, drop the stale diary rows
 *
 * The dry run writes the proposed files under --out (a scratch directory)
 * and prints a unified diff per file, so the change can be read in full
 * before anything in the vault is touched.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { program } from 'commander';
import { getAbsoluteVaultPath } from '../../src/config.js';
import { colors } from '../../src/cli-utils.js';
import { writeFileAtomicCAS } from '../../src/fs-atomic.js';
import { withFileLocks } from '../../src/file-lock.js';
import { getDailyPlanRelativePath } from '../../src/plan-utils.js';
import { minimalDailyPlan, rolePlanDirectory } from './plan-file.js';

const BLOCK_RE = /<!-- ROLE:([a-z0-9-]+):START -->\r?\n[\s\S]*?<!-- ROLE:\1:END -->(?:\r?\n)?/g;

/** Split a diary body into the role blocks (verbatim) and what remains. */
export function liftRoleBlocks(content) {
  const blocks = [];
  const remainder = content.replace(BLOCK_RE, (block) => {
    blocks.push(block);
    return '';
  });
  return { blocks, remainder };
}

function roleAndBody(block) {
  const marker = block.match(/^<!-- ROLE:([a-z0-9-]+):START -->\r?\n/);
  if (!marker) return null;
  const endIndex = block.lastIndexOf(`<!-- ROLE:${marker[1]}:END -->`);
  const inner = block.slice(marker[0].length, endIndex);
  const heading = inner.match(/^## 🤖[^\r\n]*(?:\r?\n)/);
  if (!heading) return null;
  return { role: marker[1], entries: inner.slice(heading[0].length) };
}

function mergeIntoRoleBlock(planContent, block) {
  const migrated = roleAndBody(block);
  if (!migrated) return null;
  const match = [...planContent.matchAll(BLOCK_RE)].find((item) => item[1] === migrated.role);
  if (!match) return null;

  const existingBlock = match[0];
  const existing = roleAndBody(existingBlock);
  if (!existing) return null;
  const entries = migrated.entries.replace(/\r\n/g, '\n').trim();
  const existingEntries = existing.entries.replace(/\r\n/g, '\n');
  if (!entries || existingEntries.includes(entries)) return planContent;

  const entryHeading = /^### \d{1,2}:\d{2}(?::\d{2})?\s*$/m.exec(existingEntries);
  const insertAt = entryHeading ? entryHeading.index : existingEntries.length;
  const before = existingEntries.slice(0, insertAt).replace(/\s*$/, '');
  const after = existingEntries.slice(insertAt).replace(/^\s*/, '');
  const combinedEntries = [before, entries, after].filter(Boolean).join('\n\n');
  const replacement = existingBlock.replace(existing.entries, `\n\n${combinedEntries}\n`);
  return planContent.slice(0, match.index) + replacement + planContent.slice(match.index + existingBlock.length);
}

/** Append new blocks and merge older diary entries into existing role blocks. */
export function appendBlocksToPlan(planContent, blocks) {
  let result = planContent;
  const append = [];
  for (const block of blocks) {
    const merged = mergeIntoRoleBlock(result, block);
    if (merged === null) {
      append.push(block.replace(/(?:\r?\n)+$/, ''));
    } else {
      result = merged;
    }
  }
  if (append.length === 0) return result;
  return `${result.replace(/(?:\r?\n)*$/, '\n\n')}${append.join('\n\n')}\n`;
}

/**
 * Compute every move without writing. Returns [{ date, diaryPath, planPath,
 * planExists, roles, diaryAfter, planAfter }].
 */
export function planMigration(vaultPath, plansDirectory = path.join(vaultPath, 'plans')) {
  const diaryDir = path.join(vaultPath, 'diary');
  if (!fs.existsSync(diaryDir)) {
    return [];
  }
  const moves = [];
  for (const name of fs.readdirSync(diaryDir).sort()) {
    const match = name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!match) {
      continue;
    }
    const diaryPath = path.join(diaryDir, name);
    const diary = fs.readFileSync(diaryPath, 'utf8');
    if (!diary.includes('<!-- ROLE:')) {
      continue;
    }
    const { blocks, remainder } = liftRoleBlocks(diary);
    if (blocks.length === 0) {
      continue;
    }
    const date = match[1];
    const planPath = path.join(plansDirectory, path.basename(getDailyPlanRelativePath(date)));
    const planExists = fs.existsSync(planPath);
    const planBefore = planExists ? fs.readFileSync(planPath, 'utf8') : minimalDailyPlan(date);
    const planOriginal = planExists ? planBefore : null;
    moves.push({
      date,
      diaryPath,
      planPath,
      planExists,
      diaryBefore: diary,
      planBefore: planOriginal,
      roles: blocks.map((block) => block.match(/^<!-- ROLE:([a-z0-9-]+):START -->/)[1]),
      diaryAfter: remainder,
      planAfter: appendBlocksToPlan(planBefore, blocks)
    });
  }
  return moves;
}

export function applyMigrationMoves(moves) {
  for (const move of moves) {
    withFileLocks([move.diaryPath, move.planPath], () => {
      const currentDiary = fs.readFileSync(move.diaryPath, 'utf8');
      let currentPlan = null;
      try {
        currentPlan = fs.readFileSync(move.planPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (currentDiary !== move.diaryBefore || currentPlan !== move.planBefore) {
        throw new Error(`Migration conflict for ${move.date}; no changes made to its source or plan`);
      }

      const planResult = writeFileAtomicCAS(move.planPath, move.planAfter, move.planBefore);
      if (planResult.conflict) {
        throw new Error(`Migration conflict writing ${move.planPath}; diary source was preserved`);
      }
      const diaryResult = writeFileAtomicCAS(move.diaryPath, move.diaryAfter, move.diaryBefore);
      if (diaryResult.conflict) {
        throw new Error(`Migration conflict clearing ${move.diaryPath}; diary source was preserved`);
      }
    });
  }
}

export function isInvokedDirectly(argvPath, moduleUrl) {
  return Boolean(argvPath) && path.resolve(argvPath) === fileURLToPath(moduleUrl);
}

function showDiff(label, before, after, outDir) {
  const beforePath = path.join(outDir, `${label}.before`);
  const afterPath = path.join(outDir, `${label}.after`);
  fs.mkdirSync(path.dirname(beforePath), { recursive: true });
  fs.writeFileSync(beforePath, before);
  fs.writeFileSync(afterPath, after);
  const diff = spawnSync('diff', ['-u', '--label', `${label} (now)`, '--label', `${label} (after)`, beforePath, afterPath], { encoding: 'utf8' });
  process.stdout.write(diff.stdout);
}

/** Drop the diary table's cached rows for role entries on the moved dates. */
export function dropStaleDiaryRows(db, dates) {
  const stmt = db.prepare(
    "DELETE FROM diary WHERE source LIKE 'markdown-diary%' AND json_extract(metadata, '$.type') = 'role' AND substr(date, 1, 10) = ?"
  );
  let removed = 0;
  for (const date of dates) {
    removed += stmt.run(date).changes;
  }
  return removed;
}

async function main() {
  program
    .name('plugins/roles/migrate-diary-to-plans.js')
    .option('--write', 'move the blocks (default: dry run)')
    .option('--out <dir>', 'where the dry run writes the proposed files', path.join(os.tmpdir(), 'roles-migration'))
    .option('--no-db', 'with --write: leave the diary table alone (it will converge on the next full re-sync)')
    .parse();
  const options = program.opts();

  const vaultPath = getAbsoluteVaultPath();
  const moves = planMigration(vaultPath, rolePlanDirectory(vaultPath));
  if (moves.length === 0) {
    console.log(colors.blue('ℹ') + ' No diary file holds a ROLE block; nothing to move.');
    return;
  }

  if (!options.write) {
    fs.mkdirSync(options.out, { recursive: true });
    for (const move of moves) {
      const diaryBefore = move.diaryBefore;
      const planBefore = move.planBefore || '';
      showDiff(path.relative(vaultPath, move.diaryPath), diaryBefore, move.diaryAfter, options.out);
      showDiff(path.relative(vaultPath, move.planPath), planBefore, move.planAfter, options.out);
    }
    console.log('');
    console.log(colors.cyan('Dry run:') + ` ${moves.length} diary files would move ${moves.reduce((n, m) => n + m.roles.length, 0)} role blocks.`);
    for (const move of moves) {
      console.log(`  ${move.date}: ${move.roles.join(', ')} → ${path.relative(vaultPath, move.planPath)}${move.planExists ? '' : ' (new file)'}`);
    }
    console.log(`Proposed files are under ${options.out}. Re-run with --write to apply.`);
    return;
  }

  applyMigrationMoves(moves);
  for (const move of moves) {
    console.log(colors.green('✓') + ` ${move.date}: moved ${move.roles.join(', ')} → ${path.relative(vaultPath, move.planPath)}`);
  }

  if (options.db) {
    const { getDatabase } = await import('../../src/database-service.js');
    const removed = dropStaleDiaryRows(getDatabase(), moves.map((m) => m.date));
    console.log(colors.green('✓') + ` Dropped ${removed} cached diary rows for the moved role entries.`);
  }
}

const invokedDirectly = isInvokedDirectly(process.argv[1], import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(colors.red('✗') + ` ${error.message}`);
    process.exit(1);
  });
}
