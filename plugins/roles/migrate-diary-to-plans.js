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
import { program } from 'commander';
import { getAbsoluteVaultPath } from '../../src/config.js';
import { colors } from '../../src/cli-utils.js';
import { writeFileAtomic } from '../../src/fs-atomic.js';
import { getDailyPlanRelativePath } from '../../src/plan-utils.js';
import { minimalDailyPlan } from './plan-file.js';

const BLOCK_RE = /<!-- ROLE:([a-z0-9-]+):START -->\n[\s\S]*?<!-- ROLE:\1:END -->\n?/g;

/** Split a diary body into the role blocks (verbatim) and what remains. */
export function liftRoleBlocks(content) {
  const blocks = [];
  const remainder = content
    .replace(BLOCK_RE, (block) => {
      blocks.push(block.endsWith('\n') ? block : `${block}\n`);
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '\n');
  return { blocks, remainder };
}

/** Append blocks to a plan file's content, one blank line apart. */
export function appendBlocksToPlan(planContent, blocks) {
  const base = planContent.replace(/\n*$/, '\n\n');
  return base + blocks.join('\n');
}

/**
 * Compute every move without writing. Returns [{ date, diaryPath, planPath,
 * planExists, roles, diaryAfter, planAfter }].
 */
export function planMigration(vaultPath) {
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
    const planPath = path.join(vaultPath, getDailyPlanRelativePath(date));
    const planExists = fs.existsSync(planPath);
    const planBefore = planExists ? fs.readFileSync(planPath, 'utf8') : minimalDailyPlan(date);
    moves.push({
      date,
      diaryPath,
      planPath,
      planExists,
      roles: blocks.map((block) => block.match(/^<!-- ROLE:([a-z0-9-]+):START -->/)[1]),
      diaryAfter: remainder,
      planAfter: appendBlocksToPlan(planBefore, blocks)
    });
  }
  return moves;
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
  const moves = planMigration(vaultPath);
  if (moves.length === 0) {
    console.log(colors.blue('ℹ') + ' No diary file holds a ROLE block; nothing to move.');
    return;
  }

  if (!options.write) {
    fs.mkdirSync(options.out, { recursive: true });
    for (const move of moves) {
      const diaryBefore = fs.readFileSync(move.diaryPath, 'utf8');
      const planBefore = move.planExists ? fs.readFileSync(move.planPath, 'utf8') : '';
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

  for (const move of moves) {
    writeFileAtomic(move.planPath, move.planAfter, 'utf-8');
    writeFileAtomic(move.diaryPath, move.diaryAfter, 'utf-8');
    console.log(colors.green('✓') + ` ${move.date}: moved ${move.roles.join(', ')} → ${path.relative(vaultPath, move.planPath)}`);
  }

  if (options.db) {
    const { getDatabase } = await import('../../src/database-service.js');
    const removed = dropStaleDiaryRows(getDatabase(), moves.map((m) => m.date));
    console.log(colors.green('✓') + ` Dropped ${removed} cached diary rows for the moved role entries.`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(colors.red('✗') + ` ${error.message}`);
    process.exit(1);
  });
}
