#!/usr/bin/env node

/**
 * A role's recent past: its own blocks and the chief of staff's from the
 * daily plans of the last N days, oldest first, with the user's reply lines
 * where they were written.
 *
 *   plugins/roles/history.js secretary            # secretary + chief, 14 days
 *   plugins/roles/history.js cpa --days 7 --no-chief
 */

import { program } from 'commander';
import { getAbsoluteVaultPath, getFullConfig } from '../../src/config.js';
import { colors } from '../../src/cli-utils.js';
import { ROLE_NAME_RE } from '../../src/diary-role-blocks.js';
import { collectRoleHistory, formatRoleHistory } from './role-history.js';
import { todayDateString } from './plan-file.js';

function configuredChiefRole() {
  const sources = Object.values(getFullConfig().plugins?.roles || {});
  return sources.find((source) => source?.chief_role)?.chief_role || 'chief-of-staff';
}

program
  .name('plugins/roles/history.js')
  .description("Show a role's plan-file blocks and the chief of staff's from the last N days, oldest first")
  .argument('<role>', 'role name, e.g. secretary')
  .option('--days <n>', 'days to include, ending today', (value) => parseInt(value, 10), 14)
  .option('--chief <name>', 'chief role to include alongside (default: the configured chief_role)')
  .option('--no-chief', "only the role's own blocks")
  .action((role, options) => {
    if (!ROLE_NAME_RE.test(role)) {
      console.error(colors.red('✗') + ` Invalid role name "${role}": use lowercase letters, digits, and hyphens`);
      process.exit(1);
    }
    const days = Number.isInteger(options.days) && options.days > 0 ? options.days : 14;
    const chief = options.chief === false ? null : options.chief || configuredChiefRole();
    const today = todayDateString();
    const roles = chief && chief !== role ? [role, chief] : [role];
    const history = collectRoleHistory({ vaultPath: getAbsoluteVaultPath(), roles, days, today });
    console.log(formatRoleHistory(history, { role, chief, days, today }));
  });

program.parse();
