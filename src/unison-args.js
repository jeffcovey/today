/**
 * Builds the argument list for the `unison` invocation in bin/unison-sync.
 *
 * Kept separate from the script so the conflict/backup policy is unit
 * testable — the script itself spawns unison and touches the filesystem.
 *
 * Reads these optional keys from [deployments.*.unison] in config.toml:
 *
 *   prefer      = "newer" | "older" | "local" | "remote"   (default "newer")
 *                 Which side wins when BOTH replicas changed a file since
 *                 the last sync. "local" is this device, "remote" is the
 *                 sync target. Whatever loses is kept beside the original
 *                 as `name (conflict_on_YYYY-MM-DD).ext` (-copyonconflict).
 *   backups     = true | false                              (default true)
 *                 Keep the previous version of every *.md file unison
 *                 overwrites — including one-sided propagations, which are
 *                 not conflicts and so are untouched by `prefer`. Stored
 *                 centrally on the replica that was overwritten, under
 *                 <unison dir>/backup (e.g. ~/.unison/backup on a droplet,
 *                 .data/unison/backup in the sync container).
 *   max_backups = <n>                                       (default 5)
 *   paths       = [...]   selective sync subdirectories
 *   excludes    = [...]   extra -ignore patterns
 */

export const BUILTIN_EXCLUDES = [
  'Path .git.nosync',
  'Path .git',
  'Path .sync',
  'Path .stfolder',
  'Path .stversions',
  'Name .DS_Store',
  'Path node_modules',
  // `Path node_modules` only matches a top-level node_modules; `Name` matches
  // it at any depth (e.g. archived projects under inbox/archive) so nested
  // dependency trees don't get synced.
  'Name node_modules',
  'Name *.tmp',
  'Name .*.swp',
  // Health-check marker — written locally by bin/unison-sync-healthcheck;
  // must not be propagated to the remote or it will cause spurious conflicts
  // and churn on every sync recovery.
  'Name .unison-sync-status.md',
];

export const PREFER_VALUES = ['newer', 'older', 'local', 'remote'];
export const DEFAULT_PREFER = 'newer';
export const DEFAULT_MAX_BACKUPS = 5;

/**
 * Map the config-level `prefer` value to unison's -prefer argument.
 * Unison wants either `newer`/`older` or the exact root string, so
 * `local`/`remote` resolve to the roots passed on the command line.
 */
export function resolvePrefer(prefer, { localRoot, remoteRoot }) {
  const value = prefer == null || prefer === '' ? DEFAULT_PREFER : String(prefer);
  if (!PREFER_VALUES.includes(value)) {
    throw new Error(`Invalid unison prefer "${value}" — expected one of ${PREFER_VALUES.join(', ')}`);
  }
  if (value === 'local') return localRoot;
  if (value === 'remote') return remoteRoot;
  return value;
}

/**
 * Build the full unison argv (excluding the `unison` executable).
 *
 * @param {object} opts
 * @param {string} opts.localRoot   local vault path
 * @param {string} opts.remoteRoot  ssh://user@host/path root
 * @param {string} opts.sshArgs     value for -sshargs
 * @param {object} [opts.unisonConfig]  the [deployments.*.unison] block
 * @param {boolean} [opts.oneShot]  omit -repeat watch
 */
export function buildUnisonArgs({ localRoot, remoteRoot, sshArgs, unisonConfig = {}, oneShot = false }) {
  const prefer = resolvePrefer(unisonConfig.prefer, { localRoot, remoteRoot });
  const backupsEnabled = unisonConfig.backups !== false;
  const maxBackups = Number.isInteger(unisonConfig.max_backups) && unisonConfig.max_backups > 0
    ? unisonConfig.max_backups
    : DEFAULT_MAX_BACKUPS;

  const args = [
    localRoot,
    remoteRoot,
    '-batch',          // non-interactive
    '-auto',           // accept non-conflicting changes automatically
    '-prefer', prefer, // who wins when both sides changed a file
    // Never destroy the losing side of a conflict: keep it next to the
    // original as `name (conflict_on_DATE).ext` on the replica that lost.
    '-copyonconflict',
    '-perms', '0',     // ignore permission differences (macOS vs Linux)
    '-dontchmod',      // don't try to set permissions on the remote
    '-retry', '3',     // retry on transient failures (stale locks, network blips)
    '-sshargs', sshArgs,
  ];

  if (backupsEnabled) {
    // Keep prior versions of overwritten notes. This is the only protection
    // for one-sided overwrites (e.g. another sync tool replaying a stale
    // copy onto one replica), which `prefer` never sees as a conflict.
    args.push(
      '-backup', 'Name *.md',
      '-backuploc', 'central',
      '-maxbackups', String(maxBackups),
    );
  }

  // Selective sync: if paths is set, only sync those subdirectories.
  // Empty or absent = sync everything (minus excludes).
  for (const p of unisonConfig.paths || []) {
    args.push('-path', p);
  }

  for (const exclude of [...BUILTIN_EXCLUDES, ...(unisonConfig.excludes || [])]) {
    args.push('-ignore', exclude);
  }

  if (!oneShot) {
    args.push('-repeat', 'watch');
  }

  return args;
}
