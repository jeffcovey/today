/**
 * Local Provider
 *
 * Treats the current machine as a deployment target instead of SSHing to
 * a remote server. Orchestrates docker-compose services on the host (Mac
 * or Linux) and writes configuration files directly to the local
 * filesystem.
 *
 * Use this provider for local development setups and for configuring the
 * machine you're on (e.g. a Mac where Today runs in Docker). Each local
 * deployment is identified by its `deploy_path`, which should point at the
 * Today checkout on that machine.
 *
 * What this provider does NOT do, in contrast to the SSH providers:
 * - It does not rsync or git-pull code (the local checkout IS the code).
 * - It does not install systemd units (there's no systemd inside a Mac
 *   Docker container; services are managed via docker-compose instead).
 * - It does not run apt-get or install packages (the container image is
 *   responsible for its own dependencies).
 *
 * Service management maps to docker-compose:
 *   systemctl start foo   -> docker compose up -d foo
 *   systemctl stop foo    -> docker compose stop foo
 *   systemctl restart foo -> docker compose restart foo
 *   systemctl status foo  -> docker compose ps foo
 *   journalctl -u foo     -> docker compose logs foo
 */

import { RemoteServer, printStatus, printInfo, printWarning } from '../remote-server.js';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Map a systemd service name to its docker-compose service name.
 *
 * The Today codebase uses systemd-style names everywhere (today-scheduler,
 * vault-watcher, etc.). When running locally via docker-compose, those map
 * to simpler compose service names.
 */
const SYSTEMD_TO_COMPOSE = {
  'today-scheduler': 'scheduler',
  'scheduler': 'scheduler',
  'vault-watcher': 'vault-watcher',
  'vault-web': 'vault-web',
  'inbox-api': 'inbox-api',
  'today': 'today'
};

function toComposeService(service) {
  // Drop .timer / .service suffixes systemd uses.
  const bare = service.replace(/\.(service|timer)$/, '');
  return SYSTEMD_TO_COMPOSE[bare] || bare;
}

export class LocalProvider extends RemoteServer {
  constructor(config) {
    super(config);

    // On a local deployment the "deploy path" is the Today checkout on
    // this machine. If the user didn't set one in config.toml, default to
    // the current project root — this provider runs inside the same repo
    // that owns it.
    if (!config.deploy_path && !config.deployPath) {
      this.deployPath = process.cwd();
    }

    // SSH settings are irrelevant but keep the fields populated so code
    // that reads them doesn't blow up.
    this.ip = 'localhost';
    this.sshUser = process.env.USER || 'local';
    this.sshPort = 0;
    this.sshKeyPath = null;
  }

  // --- Overrides that make RemoteServer methods run locally ------------

  /** Local deployments skip the SSH-key/IP checks. */
  validate() {
    if (!fs.existsSync(this.deployPath)) {
      printWarning(`Deploy path does not exist: ${this.deployPath}`);
      return false;
    }
    return true;
  }

  /** Execute a shell command in the deploy directory. */
  sshCmd(command, options = {}) {
    const { check = true, capture = false } = options;
    try {
      if (capture) {
        const stdout = execSync(command, {
          cwd: this.deployPath,
          encoding: 'utf8',
          shell: '/bin/bash'
        });
        return { stdout, returncode: 0 };
      }
      execSync(command, {
        cwd: this.deployPath,
        stdio: 'inherit',
        shell: '/bin/bash'
      });
      return { returncode: 0 };
    } catch (e) {
      if (check) process.exit(e.status || 1);
      return {
        stdout: (e.stdout && e.stdout.toString()) || '',
        stderr: (e.stderr && e.stderr.toString()) || '',
        returncode: e.status || 1
      };
    }
  }

  /** Execute a multi-line script locally. */
  sshScript(script, options = {}) {
    return this.sshCmd(script, options);
  }

  /**
   * "Copy" a file into the deploy tree. If the source and destination
   * resolve to the same file we no-op instead of doing a self-copy.
   */
  scpToRemote(localPath, remotePath) {
    const destAbs = path.isAbsolute(remotePath)
      ? remotePath
      : path.join(this.deployPath, remotePath);
    if (path.resolve(localPath) === path.resolve(destAbs)) {
      return;
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(localPath, destAbs);
  }

  scpFromRemote(remotePath, localPath) {
    const srcAbs = path.isAbsolute(remotePath)
      ? remotePath
      : path.join(this.deployPath, remotePath);
    if (path.resolve(srcAbs) === path.resolve(localPath)) return;
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.copyFileSync(srcAbs, localPath);
  }

  /** Rsync is a no-op locally — the code already lives at deployPath. */
  rsyncToRemote(_localPath, _remotePath, ..._extraArgs) {
    // no-op on local deployments
  }

  rsyncFromRemote(_remotePath, _localPath, ..._extraArgs) {
    // no-op on local deployments
  }

  /** Open an interactive shell in the deploy directory. */
  sshInteractive() {
    const result = spawnSync(process.env.SHELL || '/bin/bash', [], {
      cwd: this.deployPath,
      stdio: 'inherit'
    });
    return result.status || 0;
  }

  /**
   * Map systemd-style service management to docker-compose on the local
   * machine. `systemctl status foo` becomes `docker compose ps foo`, etc.
   */
  systemctl(action, service, options = {}) {
    const svc = toComposeService(service);
    const { check = false } = options;
    let cmd;
    switch (action) {
      case 'start':
      case 'enable':
        // Always pass --build so Dockerfile changes (new apk packages,
        // new binaries, etc.) are picked up automatically. Docker caches
        // unchanged layers, so this is fast when nothing changed.
        cmd = `docker compose up -d --build ${svc}`;
        break;
      case 'stop':
      case 'disable':
        cmd = `docker compose stop ${svc}`;
        break;
      case 'restart':
        cmd = `docker compose restart ${svc}`;
        break;
      case 'status':
        cmd = `docker compose ps ${svc}`;
        break;
      case 'is-active':
        // Exit 0 if the compose service has a running container.
        cmd = `[ -n "$(docker compose ps -q ${svc} 2>/dev/null)" ]`;
        break;
      default:
        cmd = `docker compose ${action} ${svc}`;
    }
    return this.sshCmd(cmd, { check });
  }

  serviceStatus(service) {
    return this.systemctl('status', service, { check: false });
  }

  viewLogs(service, options = {}) {
    const { follow = false, lines = 100 } = options;
    const svc = toComposeService(service);
    const followFlag = follow ? '-f' : '';
    this.sshCmd(`docker compose logs ${followFlag} --tail=${lines} ${svc}`);
  }

  /** Execute a command with deployPath as the working directory. */
  exec(command) {
    console.log(`⚡ Executing: ${command}`);
    return this.sshCmd(command);
  }

  async testConnection() {
    return fs.existsSync(this.deployPath);
  }

  getServerInfo() {
    return {
      name: this.name,
      provider: this.provider,
      location: 'local',
      deployPath: this.deployPath
    };
  }

  // --- Setup hooks ------------------------------------------------------

  /**
   * Local deployments don't provision the host — docker-compose does.
   * The setup command still invokes this, so we give the user a clear
   * summary of what needs to be in place before `bin/deploy <name>` will
   * succeed.
   */
  async setup() {
    printInfo(`Preparing local deployment at ${this.deployPath}...`);

    if (!fs.existsSync(this.deployPath)) {
      printWarning(`${this.deployPath} does not exist. Create the Today checkout there first.`);
      return;
    }

    const composeFile = path.join(this.deployPath, 'docker-compose.yml');
    if (!fs.existsSync(composeFile)) {
      printWarning(`No docker-compose.yml at ${composeFile}. A local deployment needs compose to manage services.`);
      return;
    }

    // Build any images the compose file describes so the first `up` doesn't
    // stall on a download.
    printInfo('Building docker-compose images (this may take a few minutes the first time)...');
    this.sshCmd('docker compose build', { check: false });

    printStatus('Local deployment setup complete');
    console.log('');
    console.log('Next steps:');
    console.log(`  1. bin/deploy ${this.name}            # Apply config and start services`);
    console.log('');
    console.log('Vault sync:');
    console.log('  For local deployments, configure git-sync as a scheduler job in config.toml:');
    console.log('');
    console.log(`    [deployments.local.${this.name}.jobs.git-sync]`);
    console.log('    schedule = "* * * * *"');
    console.log('    command = "bin/git-sync"');
    console.log('');
    console.log('  And make sure your vault remote is SSH so the container can push without a credential helper:');
    console.log('    cd <your-vault>');
    console.log('    git remote set-url origin git@github.com:<user>/<vault-repo>.git');
  }

  /**
   * Resilio Sync is systemd-based and not supported on local deployments.
   * The setup command catches this and tells the user to use git-sync.
   */
  async setupResilioSync() {
    printWarning('Resilio Sync is not supported on local deployments.');
    console.log('  Use git-sync instead: add a git-sync job to your config.toml under');
    console.log(`    [deployments.local.${this.name}.jobs.git-sync]`);
  }

  /**
   * For local deployments git-sync is a scheduler job rather than an
   * out-of-band systemd timer, so there's no separate install step. We
   * print guidance and exit without modifying anything.
   */
  async setupGitSync() {
    printInfo('Local deployments run git-sync as a scheduler job, not a systemd timer.');
    console.log('');
    console.log('Add this to your config.toml under the deployment block:');
    console.log('');
    console.log(`  [deployments.local.${this.name}.jobs.git-sync]`);
    console.log('  schedule = "* * * * *"');
    console.log('  command = "bin/git-sync"');
    console.log('  description = "Pull/rebase/push vault via git"');
    console.log('');
    console.log(`Then: bin/deploy ${this.name}`);
  }
}

export default LocalProvider;
