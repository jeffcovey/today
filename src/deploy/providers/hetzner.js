/**
 * Hetzner Provider
 *
 * Extends RemoteServer for Hetzner Cloud servers.
 * Similar to DigitalOcean but with Hetzner-specific defaults.
 */

import { RemoteServer, printStatus, printInfo, printWarning } from '../remote-server.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

export class HetznerProvider extends RemoteServer {
  constructor(config) {
    super(config);

    // Hetzner-specific defaults
    this.sshKeyPath = config.sshKeyPath || this.getHetznerSshKeyPath();
  }

  /**
   * Get Hetzner-specific SSH key path
   */
  getHetznerSshKeyPath() {
    // Check for Hetzner-specific key first
    const hetznerKey = path.join(os.homedir(), '.ssh', 'hetzner_key');
    if (fs.existsSync(hetznerKey)) {
      return hetznerKey;
    }
    // Fall back to generic deploy key
    const deployKey = path.join(os.homedir(), '.ssh', 'deploy_key');
    if (fs.existsSync(deployKey)) {
      return deployKey;
    }
    return path.join(os.homedir(), '.ssh', 'id_rsa');
  }

  /**
   * Initial setup of a Hetzner Cloud server
   */
  async setup() {
    printInfo('Setting up Hetzner Cloud server...');

    // Hetzner servers typically come with a minimal Debian/Ubuntu
    this.sshScript(`
      set -e

      echo "Updating system packages..."
      apt-get update
      apt-get upgrade -y

      echo "Installing Node.js 20.x..."
      if ! command -v node &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
      fi
      node --version
      npm --version

      echo "Installing system dependencies..."
      apt-get install -y git nginx certbot python3-certbot-nginx sqlite3 rsync jq

      echo "Creating deployment directory..."
      mkdir -p ${this.deployPath}
      mkdir -p ${this.deployPath}/.data

      echo "Setting up firewall..."
      # Hetzner uses ufw or iptables
      if command -v ufw &> /dev/null; then
        ufw allow OpenSSH
        ufw allow 'Nginx Full'
        ufw --force enable
      fi

      echo "✓ Base setup complete"
    `);

    printStatus('Hetzner server setup complete');
  }

  /**
   * Setup SSL certificate
   */
  async setupSsl() {
    if (!this.domain) {
      printWarning('No domain configured, skipping SSL setup');
      return;
    }

    printInfo(`Setting up SSL for ${this.domain}...`);

    this.sshScript(`
      set -e

      if [ -f /etc/letsencrypt/live/${this.domain}/fullchain.pem ]; then
        echo "Certificate already exists for ${this.domain}"
        certbot renew --dry-run
      else
        certbot --nginx -d ${this.domain} --non-interactive --agree-tos --email ${this.adminEmail} --redirect
      fi
    `);

    printStatus('SSL configured');
  }

  /**
   * Get provider-specific info
   */
  getProviderInfo() {
    return {
      ...super.getServerInfo(),
      provider: 'hetzner',
      providerLabel: 'Hetzner Cloud Server'
    };
  }
}

export default HetznerProvider;
