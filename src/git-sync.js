import { execFileSync } from 'child_process';
import { appendFileSync, existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import os from 'os';

export function defaultLogPath() {
  if (process.platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Logs', 'git-sync.log');
  }
  return '/var/log/git-sync.log';
}

export function runGitSync({ vaultPath, logPath = defaultLogPath(), env = process.env }) {
  const gitEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/echo'
  };

  function log(msg) {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try {
      appendFileSync(logPath, line);
    } catch {
      process.stderr.write(line);
    }
  }

  function runGit(args) {
    return execFileSync('git', args, {
      cwd: vaultPath,
      env: gitEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  function stderrOf(err) {
    return (err.stderr && err.stderr.toString().trim()) || err.message || '';
  }

  if (!existsSync(vaultPath)) {
    log(`FATAL vault path ${vaultPath} does not exist`);
    return 1;
  }

  let gitDir;
  try {
    gitDir = runGit(['rev-parse', '--git-dir']).toString().trim();
    if (!isAbsolute(gitDir)) gitDir = join(vaultPath, gitDir);
  } catch (err) {
    log(`FATAL ${vaultPath} is not a git repo: ${stderrOf(err)}`);
    return 1;
  }

  const rebaseInProgress = () =>
    existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'));

  if (rebaseInProgress()) {
    log('WARN stale rebase state detected, aborting');
    try { runGit(['rebase', '--abort']); } catch { /* best-effort */ }
  }

  try {
    runGit(['pull', '--rebase', '--autostash']);
  } catch (err) {
    log(`ERROR pull failed: ${stderrOf(err)}`);
    if (rebaseInProgress()) {
      try { runGit(['rebase', '--abort']); } catch { /* best-effort */ }
    }
    return 2;
  }

  try {
    runGit(['push']);
  } catch (err) {
    log(`ERROR push failed: ${stderrOf(err)}`);
    return 3;
  }

  return 0;
}
