/**
 * RemoteServer - Base class for SSH-based server operations
 *
 * Provides common functionality for connecting to and managing remote servers:
 * - SSH command execution
 * - SCP/rsync file transfers
 * - Systemd service management
 * - Script execution
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ANSI colors
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const RED = '\x1b[0;31m';
const NC = '\x1b[0m';

export function printStatus(msg) {
  console.log(`${GREEN}✓${NC} ${msg}`);
}

export function printInfo(msg) {
  console.log(`${BLUE}ℹ${NC} ${msg}`);
}

export function printWarning(msg) {
  console.log(`${YELLOW}⚠${NC} ${msg}`);
}

export function printError(msg) {
  console.log(`${RED}✗${NC} ${msg}`);
}

/**
 * Base class for remote server operations
 */
export class RemoteServer {
  /**
   * @param {Object} config - Deployment configuration
   * @param {string} config.name - Deployment name (e.g., 'production')
   * @param {string} config.provider - Provider type (e.g., 'digitalocean')
   * @param {string} config.ip - Server IP address
   * @param {string} config.domain - Domain name (optional)
   * @param {string} config.deployPath - Path on server (e.g., '/opt/today')
   * @param {string} config.remoteVaultPath - Vault path relative to deployPath
   * @param {string} config.sshUser - SSH username (default: 'root')
   * @param {number} config.sshPort - SSH port (default: 22)
   * @param {string} config.sshKeyPath - Path to SSH key
   */
  constructor(config) {
    this.name = config.name;
    this.provider = config.provider;
    this.ip = config.ip;
    this.domain = config.domain;
    this.deployPath = config.deployPath || '/opt/today';
    this.remoteVaultPath = config.remoteVaultPath || 'vault';
    this.sshUser = config.sshUser || 'root';
    this.sshPort = config.sshPort || 22;
    this.sshKeyPath = config.sshKeyPath || this.getDefaultSshKeyPath();
    this.adminEmail = config.adminEmail || 'admin@example.com';
  }

  /**
   * Get default SSH key path
   */
  getDefaultSshKeyPath() {
    // Check for deployment-specific key first
    const deployKey = path.join(os.homedir(), '.ssh', 'deploy_key');
    if (fs.existsSync(deployKey)) {
      return deployKey;
    }
    // Fall back to default SSH key
    return path.join(os.homedir(), '.ssh', 'id_rsa');
  }

  /**
   * Validate that the server is configured
   */
  validate() {
    if (!this.ip) {
      printError(`Server IP not configured for deployment '${this.name}'`);
      console.log(`Set the environment variable or run: bin/today configure`);
      return false;
    }
    if (!fs.existsSync(this.sshKeyPath)) {
      printError(`SSH key not found: ${this.sshKeyPath}`);
      console.log('Generate one with: ssh-keygen -t ed25519 -f ~/.ssh/deploy_key');
      return false;
    }
    return true;
  }

  /**
   * Run a local command
   */
  run(cmd, options = {}) {
    const { check = true, capture = false } = options;

    try {
      if (capture) {
        const result = execSync(cmd, { encoding: 'utf8', shell: true, ...options });
        return { stdout: result, returncode: 0 };
      } else {
        execSync(cmd, { stdio: 'inherit', shell: true, ...options });
        return { returncode: 0 };
      }
    } catch (e) {
      if (check) {
        process.exit(e.status || 1);
      }
      return { stdout: e.stdout || '', stderr: e.stderr || '', returncode: e.status || 1 };
    }
  }

  /**
   * Get SSH command prefix
   */
  getSshPrefix() {
    return `ssh -i "${this.sshKeyPath}" -p ${this.sshPort}`;
  }

  /**
   * Execute a command on the remote server via SSH
   */
  sshCmd(command, options = {}) {
    const { check = true, capture = false } = options;
    const sshArgs = `${this.getSshPrefix()} ${this.sshUser}@${this.ip} ${JSON.stringify(command)}`;
    return this.run(sshArgs, { check, capture });
  }

  /**
   * Execute a multi-line script on the remote server
   */
  sshScript(script, options = {}) {
    const { check = true } = options;
    // Base64 encode the script to avoid quoting issues
    const encoded = Buffer.from(script).toString('base64');
    return this.sshCmd(`echo ${encoded} | base64 -d | bash`, { check });
  }

  /**
   * Copy a file to the remote server
   */
  scpToRemote(localPath, remotePath) {
    this.run(`scp -i "${this.sshKeyPath}" -P ${this.sshPort} "${localPath}" ${this.sshUser}@${this.ip}:${remotePath}`);
  }

  /**
   * Copy a file from the remote server
   */
  scpFromRemote(remotePath, localPath) {
    this.run(`scp -i "${this.sshKeyPath}" -P ${this.sshPort} ${this.sshUser}@${this.ip}:${remotePath} "${localPath}"`);
  }

  /**
   * Rsync files to remote server
   */
  rsyncToRemote(localPath, remotePath, ...extraArgs) {
    const args = [
      'rsync', '-avz',
      '-e', `"ssh -i ${this.sshKeyPath} -p ${this.sshPort}"`,
      ...extraArgs,
      `"${localPath}"`,
      `${this.sshUser}@${this.ip}:${remotePath}`
    ];
    this.run(args.join(' '));
  }

  /**
   * Rsync files from remote server
   */
  rsyncFromRemote(remotePath, localPath, ...extraArgs) {
    const args = [
      'rsync', '-avz',
      '-e', `"ssh -i ${this.sshKeyPath} -p ${this.sshPort}"`,
      ...extraArgs,
      `${this.sshUser}@${this.ip}:${remotePath}`,
      `"${localPath}"`
    ];
    this.run(args.join(' '));
  }

  /**
   * Open an interactive SSH session
   */
  sshInteractive() {
    const result = spawnSync('ssh', [
      '-i', this.sshKeyPath,
      '-p', String(this.sshPort),
      `${this.sshUser}@${this.ip}`
    ], { stdio: 'inherit' });
    return result.status || 0;
  }

  /**
   * Manage systemd services
   */
  systemctl(action, service, options = {}) {
    const { check = false } = options;
    return this.sshCmd(`systemctl ${action} ${service}`, { check });
  }

  /**
   * Get service status
   */
  serviceStatus(service) {
    return this.sshCmd(`systemctl status ${service} --no-pager`, { check: false });
  }

  /**
   * Restart a service
   */
  restartService(service) {
    printInfo(`Restarting ${service}...`);
    this.systemctl('restart', service);
    printStatus(`${service} restarted`);
  }

  /**
   * View service logs
   */
  viewLogs(service, options = {}) {
    const { follow = false, lines = 100 } = options;
    const followFlag = follow ? '-f' : '';
    this.sshCmd(`journalctl -u ${service} ${followFlag} -n ${lines}`);
  }

  /**
   * Execute a command in the deploy directory
   */
  exec(command) {
    console.log(`⚡ Executing: ${command}`);
    return this.sshCmd(`cd ${this.deployPath} && ${command}`);
  }

  /**
   * Check if server is reachable
   */
  async testConnection() {
    try {
      const result = this.sshCmd('echo "connected"', { check: false, capture: true });
      return result.returncode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Get server info
   */
  getServerInfo() {
    return {
      name: this.name,
      provider: this.provider,
      ip: this.ip,
      domain: this.domain,
      deployPath: this.deployPath,
      sshUser: this.sshUser,
      sshPort: this.sshPort
    };
  }

  /**
   * Template a string with deployment variables
   */
  template(str) {
    return str
      .replace(/\{\{deploy_path\}\}/g, this.deployPath)
      .replace(/\{\{domain\}\}/g, this.domain || '')
      .replace(/\{\{remote_vault_path\}\}/g, this.remoteVaultPath)
      .replace(/\{\{ssh_user\}\}/g, this.sshUser)
      .replace(/\{\{admin_email\}\}/g, this.adminEmail);
  }

  /**
   * Upload and install a templated file
   */
  installTemplatedFile(localPath, remotePath, options = {}) {
    const { mode = '644', sudo = false } = options;

    // Read and template the file
    const content = fs.readFileSync(localPath, 'utf8');
    const templated = this.template(content);

    // Write to temp file
    const tmpFile = `/tmp/deploy-${Date.now()}-${path.basename(localPath)}`;
    fs.writeFileSync(tmpFile, templated);

    // Upload
    this.scpToRemote(tmpFile, `/tmp/${path.basename(tmpFile)}`);

    // Move to final location
    const mvCmd = sudo
      ? `sudo mv /tmp/${path.basename(tmpFile)} ${remotePath} && sudo chmod ${mode} ${remotePath}`
      : `mv /tmp/${path.basename(tmpFile)} ${remotePath} && chmod ${mode} ${remotePath}`;
    this.sshCmd(mvCmd);

    // Cleanup local temp file
    fs.unlinkSync(tmpFile);
  }
}

export default RemoteServer;
