/**
 * Deploy command
 *
 * Deploys code and configuration to the remote server
 */

import { printStatus, printInfo, printWarning, printError } from '../remote-server.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');

export async function deployCommand(server, args = []) {
  console.log(`🚢 Deploying to ${server.name} (${server.provider})...`);

  if (!server.validate()) {
    process.exit(1);
  }

  const deployPath = server.deployPath;

  // Create directories
  printInfo(`Creating directories on ${server.ip}...`);
  server.sshCmd(`mkdir -p ${deployPath} ${deployPath}/.data`);

  // Check if git repo exists on server
  const gitCheck = server.sshCmd(`[ -d ${deployPath}/.git ] && echo "exists"`, { check: false, capture: true });
  const hasGit = gitCheck.stdout.includes('exists');

  if (hasGit) {
    // Git pull
    printInfo('Pulling latest code from git...');
    server.sshCmd(`cd ${deployPath} && git pull`);
  } else {
    // Initial clone or rsync
    printInfo('Syncing code via rsync...');
    server.rsyncToRemote(
      `${PROJECT_ROOT}/`,
      `${deployPath}/`,
      '--exclude=node_modules',
      '--exclude=.data',
      '--exclude=vault',
      '--delete'
    );
  }

  // Sync config files (always)
  printInfo('Syncing configuration files...');
  const configFiles = ['.env', '.env.keys', 'config.toml'].filter(f =>
    fs.existsSync(path.join(PROJECT_ROOT, f))
  );

  for (const file of configFiles) {
    server.scpToRemote(path.join(PROJECT_ROOT, file), `${deployPath}/${file}`);
  }

  // Configure git
  server.sshCmd(`git config --global --add safe.directory ${deployPath}`, { check: false });
  server.sshCmd("git config --global user.email 'today-bot@system.local' && git config --global user.name 'Today Bot'", { check: false });

  // Configure GitHub auth if token available
  printInfo('Configuring GitHub authentication...');
  server.sshCmd(`cd ${deployPath} && npx dotenvx run -- bash -c 'if [ -n "$GITHUB_TOKEN" ]; then echo "https://$GITHUB_TOKEN:x-oauth-basic@github.com" > ~/.git-credentials && git config --global credential.helper store && echo "✓ GitHub token configured"; fi'`, { check: false });

  // Install dependencies
  printInfo('Installing dependencies...');
  server.sshCmd(`cd ${deployPath} && npm install --production`);

  // Run migrations
  printInfo('Running database migrations...');
  const migrationResult = server.sshCmd(`cd ${deployPath} && timeout 30 npx dotenvx run -- node src/migrations.js`, { check: false });
  if (migrationResult.returncode !== 0) {
    printWarning('Migrations may have already run');
  }

  // Fix vault ownership for Resilio Sync (if vault is owned by rslsync)
  const vaultOwner = server.sshCmd(`stat -c %U ${deployPath}/vault 2>/dev/null || echo ''`, { check: false, capture: true });
  if (vaultOwner.stdout.trim() === 'rslsync') {
    printInfo('Fixing vault ownership for Resilio Sync...');
    server.sshCmd(`chown -R rslsync:rslsync ${deployPath}/vault`, { check: false });
  }

  // Install logrotate config if it exists
  const logrotateConfig = path.join(PROJECT_ROOT, 'config', 'logrotate-today');
  if (fs.existsSync(logrotateConfig)) {
    printInfo('Installing logrotate configuration...');
    server.installTemplatedFile(logrotateConfig, '/etc/logrotate.d/today', { sudo: true });
  }

  // Install systemd services
  await installServices(server);

  // Write scheduler jobs config
  if (server.jobs && Object.keys(server.jobs).length > 0) {
    printInfo('Writing scheduler jobs config...');
    const jobsJson = JSON.stringify(server.jobs, null, 2);
    server.sshScript(`cat > ${deployPath}/.data/scheduler-config.json << 'JOBS_EOF'
${jobsJson}
JOBS_EOF`);
    printStatus(`Configured ${Object.keys(server.jobs).length} scheduled job(s)`);
  }

  // Enable and start configured services
  const enabledServices = Object.entries(server.services || {})
    .filter(([_, enabled]) => enabled)
    .map(([name]) => name === 'scheduler' ? 'today-scheduler' : name);

  if (enabledServices.length > 0) {
    printInfo(`Enabling configured services: ${enabledServices.join(', ')}`);
    for (const service of enabledServices) {
      server.systemctl('enable', service, { check: false });
      server.systemctl('restart', service, { check: false });
    }
    printStatus(`Started ${enabledServices.length} service(s)`);
  } else {
    printInfo('No services configured. Enable in config.toml under [deployments.*.services]');
  }

  printStatus('Deployment complete!');
  console.log('');
  console.log(`  Server: ${server.ip}`);
  if (server.domain) {
    console.log(`  Domain: https://${server.domain}`);
  }
  console.log(`  Path: ${deployPath}`);
}

/**
 * Install systemd service files
 */
async function installServices(server) {
  const servicesDir = path.join(PROJECT_ROOT, 'config', 'services');

  if (!fs.existsSync(servicesDir)) {
    printWarning('No services directory found, skipping service installation');
    return;
  }

  printInfo('Installing systemd services...');

  const serviceFiles = fs.readdirSync(servicesDir).filter(f => f.endsWith('.service'));

  for (const serviceFile of serviceFiles) {
    const servicePath = path.join(servicesDir, serviceFile);
    server.installTemplatedFile(servicePath, `/etc/systemd/system/${serviceFile}`, { sudo: true });
  }

  if (serviceFiles.length > 0) {
    server.sshCmd('systemctl daemon-reload');
    printStatus(`Installed ${serviceFiles.length} service(s)`);
  }
}

export default deployCommand;
