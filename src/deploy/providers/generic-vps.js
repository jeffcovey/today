/**
 * Generic VPS Provider
 *
 * Works with any Linux VPS that has SSH access.
 * Supports Ubuntu, Debian, and other common distributions.
 */

import { RemoteServer, printStatus, printInfo, printWarning, printError } from '../remote-server.js';

export class GenericVpsProvider extends RemoteServer {
  constructor(config) {
    super(config);
  }

  /**
   * Detect the Linux distribution
   */
  detectDistro() {
    try {
      const result = this.sshCmd('cat /etc/os-release | grep "^ID=" | cut -d= -f2 | tr -d \'"\'', {
        check: false,
        capture: true
      });
      return result.stdout.trim().toLowerCase();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get the package manager for this distribution
   */
  getPackageManager() {
    const distro = this.detectDistro();

    switch (distro) {
      case 'ubuntu':
      case 'debian':
      case 'raspbian':
        return { install: 'apt-get install -y', update: 'apt-get update' };
      case 'fedora':
      case 'rhel':
      case 'centos':
      case 'rocky':
      case 'almalinux':
        return { install: 'dnf install -y', update: 'dnf check-update || true' };
      case 'arch':
      case 'manjaro':
        return { install: 'pacman -S --noconfirm', update: 'pacman -Sy' };
      case 'alpine':
        return { install: 'apk add', update: 'apk update' };
      default:
        printWarning(`Unknown distribution: ${distro}, assuming apt-based`);
        return { install: 'apt-get install -y', update: 'apt-get update' };
    }
  }

  /**
   * Initial setup of the server
   */
  async setup() {
    printInfo('Setting up server...');

    const distro = this.detectDistro();
    printInfo(`Detected distribution: ${distro}`);

    const pm = this.getPackageManager();

    this.sshScript(`
      set -e

      echo "Updating system packages..."
      ${pm.update}

      echo "Installing Node.js..."
      if ! command -v node &> /dev/null; then
        # Try to install Node.js based on distro
        if command -v apt-get &> /dev/null; then
          curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
          apt-get install -y nodejs
        elif command -v dnf &> /dev/null; then
          dnf module enable -y nodejs:20
          dnf install -y nodejs
        elif command -v pacman &> /dev/null; then
          pacman -S --noconfirm nodejs npm
        elif command -v apk &> /dev/null; then
          apk add nodejs npm
        else
          echo "Could not install Node.js automatically"
          exit 1
        fi
      fi
      node --version
      npm --version

      echo "Installing dependencies..."
      ${pm.install} git sqlite3 rsync || echo "Some packages may not be available"

      echo "Creating deployment directory..."
      mkdir -p ${this.deployPath}
      mkdir -p ${this.deployPath}/.data

      echo "✓ Base setup complete"
    `);

    printStatus('Server setup complete');
  }

  /**
   * Setup nginx (optional for generic VPS)
   */
  async setupNginx() {
    printInfo('Setting up nginx...');

    const pm = this.getPackageManager();

    this.sshScript(`
      set -e

      ${pm.install} nginx certbot python3-certbot-nginx || ${pm.install} nginx

      systemctl enable nginx
      systemctl start nginx

      echo "✓ Nginx installed"
    `);

    printStatus('Nginx setup complete');
  }

  /**
   * Setup SSL (requires nginx and domain)
   */
  async setupSsl() {
    if (!this.domain) {
      printWarning('No domain configured, skipping SSL setup');
      return;
    }

    printInfo(`Setting up SSL for ${this.domain}...`);

    this.sshScript(`
      set -e

      if ! command -v certbot &> /dev/null; then
        echo "Certbot not installed, skipping SSL"
        exit 0
      fi

      if [ -f /etc/letsencrypt/live/${this.domain}/fullchain.pem ]; then
        echo "Certificate already exists"
      else
        certbot --nginx -d ${this.domain} --non-interactive --agree-tos --email ${this.adminEmail} --redirect || echo "SSL setup failed, continuing..."
      fi
    `);

    printStatus('SSL setup complete');
  }

  /**
   * Get provider-specific info
   */
  getProviderInfo() {
    return {
      ...super.getServerInfo(),
      provider: 'generic-vps',
      providerLabel: 'Generic Linux VPS',
      distro: this.detectDistro()
    };
  }
}

export default GenericVpsProvider;
