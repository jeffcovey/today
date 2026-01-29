/**
 * DigitalOcean Provider
 *
 * Extends RemoteServer with DigitalOcean-specific functionality.
 * Assumes Ubuntu droplets (the most common DO choice).
 */

import { RemoteServer, printStatus, printInfo, printWarning } from '../remote-server.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

export class DigitalOceanProvider extends RemoteServer {
  constructor(config) {
    super(config);

    // DO-specific defaults
    this.sshKeyPath = config.sshKeyPath || this.getDoSshKeyPath();
  }

  /**
   * Get DigitalOcean-specific SSH key path
   */
  getDoSshKeyPath() {
    // Check for DO-specific key first
    const doKey = path.join(os.homedir(), '.ssh', 'do_deploy_key');
    if (fs.existsSync(doKey)) {
      return doKey;
    }
    // Fall back to generic deploy key
    const deployKey = path.join(os.homedir(), '.ssh', 'deploy_key');
    if (fs.existsSync(deployKey)) {
      return deployKey;
    }
    // Fall back to default
    return path.join(os.homedir(), '.ssh', 'id_rsa');
  }

  /**
   * Initial setup of a new DigitalOcean droplet
   */
  async setup() {
    printInfo('Setting up DigitalOcean droplet...');

    // Install Node.js and dependencies
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

      echo "Installing Chromium dependencies for Puppeteer..."
      apt-get install -y libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
        libpango-1.0-0 libcairo2 libasound2t64 libnspr4 libnss3 libxshmfence1 \
        libx11-xcb1 libxfixes3 fonts-liberation

      echo "Creating deployment directory..."
      mkdir -p ${this.deployPath}
      mkdir -p ${this.deployPath}/.data

      echo "Setting up firewall..."
      ufw allow OpenSSH
      ufw allow 'Nginx Full'
      ufw --force enable

      echo "Configuring log rotation..."
      cat > /etc/logrotate.d/rsyslog << 'LOGROTATE'
/var/log/syslog
/var/log/mail.log
/var/log/kern.log
/var/log/auth.log
/var/log/user.log
/var/log/cron.log
{
    rotate 4
    daily
    size 100M
    missingok
    notifempty
    compress
    delaycompress
    sharedscripts
    postrotate
        /usr/lib/rsyslog/rsyslog-rotate
    endscript
}
LOGROTATE

      echo "✓ Base setup complete"
    `);

    printStatus('Base setup complete');
  }

  /**
   * Setup SSL certificate with Let's Encrypt
   */
  async setupSsl() {
    if (!this.domain) {
      printWarning('No domain configured, skipping SSL setup');
      return;
    }

    printInfo(`Setting up SSL for ${this.domain}...`);

    this.sshScript(`
      set -e

      # Check if certificate already exists
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
   * Install Resilio Sync for vault synchronization
   */
  async setupResilioSync() {
    printInfo('Setting up Resilio Sync...');

    this.sshScript(`
      set -e

      # Check if already installed
      if command -v rslsync &> /dev/null; then
        echo "Resilio Sync already installed"
        systemctl status resilio-sync --no-pager || true
        exit 0
      fi

      echo "Installing Resilio Sync..."
      wget -qO - https://linux-packages.resilio.com/resilio-sync/key.asc | gpg --dearmor | tee /usr/share/keyrings/resilio-sync-archive-keyring.gpg >/dev/null
      echo "deb [signed-by=/usr/share/keyrings/resilio-sync-archive-keyring.gpg] https://linux-packages.resilio.com/resilio-sync/deb resilio-sync non-free" | tee /etc/apt/sources.list.d/resilio-sync.list
      apt-get update
      apt-get install -y resilio-sync

      # Create user and directories
      useradd -r -s /bin/false rslsync 2>/dev/null || true
      mkdir -p /etc/resilio-sync /var/lib/resilio-sync /var/run/resilio-sync
      mkdir -p ${this.deployPath}/${this.remoteVaultPath}
      chown -R rslsync:rslsync ${this.deployPath}/${this.remoteVaultPath}
      chmod -R 775 ${this.deployPath}/${this.remoteVaultPath}
      chown rslsync:rslsync /var/lib/resilio-sync /var/run/resilio-sync

      # Generate password and create config
      RESILIO_PASSWORD=$(openssl rand -base64 12)
      echo "RESILIO_PASSWORD=$RESILIO_PASSWORD" > ${this.deployPath}/.resilio-password
      chmod 600 ${this.deployPath}/.resilio-password

      cat > /etc/resilio-sync/config.json << 'CONFIG'
{
    "device_name": "Today Server - ${this.name}",
    "listening_port": 8888,
    "storage_path": "/var/lib/resilio-sync/",
    "pid_file": "/var/run/resilio-sync/sync.pid",
    "use_upnp": true,
    "download_limit": 0,
    "upload_limit": 0,
    "webui": {
        "listen": "127.0.0.1:8889",
        "login": "admin",
        "password": "PLACEHOLDER"
    }
}
CONFIG
      sed -i "s/PLACEHOLDER/$RESILIO_PASSWORD/" /etc/resilio-sync/config.json
      chown rslsync:rslsync /etc/resilio-sync/config.json
      chmod 600 /etc/resilio-sync/config.json

      # Create systemd service
      cat > /etc/systemd/system/resilio-sync.service << 'SERVICE'
[Unit]
Description=Resilio Sync
After=network.target

[Service]
Type=simple
User=rslsync
Group=rslsync
RuntimeDirectory=resilio-sync
RuntimeDirectoryMode=0755
ExecStartPre=/bin/mkdir -p /var/run/resilio-sync
ExecStartPre=/bin/chown rslsync:rslsync /var/run/resilio-sync
ExecStart=/usr/bin/rslsync --config /etc/resilio-sync/config.json --nodaemon
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

      systemctl daemon-reload
      systemctl enable resilio-sync
      systemctl start resilio-sync

      # Filter rslsync from syslog (it's very chatty and fills up disk)
      echo ':programname, isequal, "rslsync" stop' > /etc/rsyslog.d/10-rslsync.conf
      systemctl restart rsyslog

      echo ""
      echo "✓ Resilio Sync installed"
      echo "  Password: $RESILIO_PASSWORD"
      echo "  Config: /etc/resilio-sync/config.json"
      echo "  Note: rslsync logs filtered from syslog (too verbose)"
    `);

    printStatus('Resilio Sync setup complete');
  }

  /**
   * Setup Ollama for local LLM support
   */
  async setupOllama() {
    printInfo('Setting up Ollama...');

    this.sshScript(`
      set -e

      # Check memory
      AVAIL_MB=$(free -m | awk '/^Mem:/ {print $7}')
      if [ "$AVAIL_MB" -lt 800 ]; then
        echo "⚠ Warning: Only ${AVAIL_MB}MB RAM available"
        echo "  LLMs need at least 800MB. Consider upgrading to a 2GB droplet."
      fi

      # Install Ollama
      if ! command -v ollama &> /dev/null; then
        curl -fsSL https://ollama.com/install.sh | sh
      fi

      # Enable and start service
      systemctl enable ollama
      systemctl start ollama

      echo ""
      ollama --version
      echo "✓ Ollama installed and running"
    `);

    printStatus('Ollama setup complete');
  }

  /**
   * Get provider-specific info
   */
  getProviderInfo() {
    return {
      ...super.getServerInfo(),
      provider: 'digitalocean',
      providerLabel: 'DigitalOcean Droplet'
    };
  }
}

export default DigitalOceanProvider;
