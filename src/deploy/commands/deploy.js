/**
 * Deploy command
 *
 * Deploys code and configuration to the remote server
 */

import { printStatus, printInfo, printWarning, printError } from '../remote-server.js';
import { configKeyToSystemdName } from '../services.js';
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

  // Local deployments take a very different path: no code sync, no apt,
  // no systemd, just "write config, (re)start compose services".
  if (server.provider === 'local') {
    return deployLocal(server);
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

  // Get the config path to determine if it's in vault or standalone
  const { getConfigPath } = await import('../../config.js');
  const configPath = getConfigPath();
  const relativeConfigPath = configPath.replace(PROJECT_ROOT + '/', '');
  const configInVault = relativeConfigPath.startsWith('vault/');

  // Base config files (env files)
  const configFiles = ['.env', '.env.keys'].filter(f =>
    fs.existsSync(path.join(PROJECT_ROOT, f))
  );

  // Add config-path bootstrap file if it exists (tells server where config is)
  if (fs.existsSync(path.join(PROJECT_ROOT, '.data', 'config-path'))) {
    configFiles.push('.data/config-path');
  }

  // Only copy config if it's NOT in vault (vault is synced via Resilio)
  if (!configInVault && fs.existsSync(configPath)) {
    configFiles.push(relativeConfigPath);
  }

  for (const file of configFiles) {
    server.scpToRemote(path.join(PROJECT_ROOT, file), `${deployPath}/${file}`);
  }

  if (configInVault) {
    printInfo(`Config file in vault (${relativeConfigPath}) - synced via Resilio`);
  }

  // Write deployment name file (used for runtime AI config overrides)
  printInfo(`Setting deployment name: ${server.name}`);
  const deploymentNameFile = path.join(PROJECT_ROOT, '.deploy-deployment-name');
  fs.writeFileSync(deploymentNameFile, server.name + '\n');
  server.scpToRemote(deploymentNameFile, `${deployPath}/.data/deployment-name`);
  fs.unlinkSync(deploymentNameFile);

  // Apply deployment-specific AI overrides to config (only if config is NOT in vault)
  // If config is in vault, overrides are applied at runtime via .data/deployment-name
  if (server.ai && !configInVault) {
    printInfo('Applying deployment AI configuration...');
    const { applyDeploymentOverrides } = await import('../../config.js');
    const tempConfigPath = path.join(PROJECT_ROOT, '.deploy-config.toml');
    applyDeploymentOverrides(server.ai, tempConfigPath);
    server.scpToRemote(tempConfigPath, `${deployPath}/${relativeConfigPath}`);
    fs.unlinkSync(tempConfigPath);
    printStatus('AI configuration applied');
  } else if (server.ai && configInVault) {
    printInfo('AI overrides will be applied at runtime (config in vault)');
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
    .map(([name]) => configKeyToSystemdName(name));

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

  // Clean up stale services that no longer have templates
  await cleanupStaleServices(server, serviceFiles);
}

/**
 * Remove systemd services that reference our deploy path but no longer have templates.
 *
 * "Known" services come from two places in the repo:
 *
 *   - config/services/*.service — always-installed services (the set passed in
 *     as `currentServiceFiles` from installServices).
 *   - deploy/systemd/*.service — opt-in services installed out-of-band by
 *     setup hooks like setupGitSync(). These are NOT installed by the regular
 *     deploy path, but they ARE expected to persist across deploys once a
 *     user has opted in via `bin/deploy <name> setup --git-sync` etc.
 *
 * Without counting `deploy/systemd/` here, regular `bin/deploy <name>` silently
 * uninstalls git-sync.service every run, which orphans git-sync.timer and
 * breaks vault sync until the healthcheck catches up 10 minutes later.
 */
async function cleanupStaleServices(server, currentServiceFiles) {
  const deployPath = server.deployPath;

  // Expand the "don't remove" set to also include opt-in units from
  // deploy/systemd/, so regular deploys preserve them.
  const optionalServicesDir = path.join(PROJECT_ROOT, 'deploy', 'systemd');
  const optionalServiceFiles = fs.existsSync(optionalServicesDir)
    ? fs.readdirSync(optionalServicesDir).filter(f => f.endsWith('.service'))
    : [];
  const knownServiceFiles = [...currentServiceFiles, ...optionalServiceFiles];

  // Find all .service files on the server that reference our deploy path
  const result = server.sshCmd(
    `grep -l '${deployPath}' /etc/systemd/system/*.service 2>/dev/null || true`,
    { capture: true, check: false }
  );

  const remoteServices = result.stdout.trim().split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(fullPath => fullPath.split('/').pop());

  if (remoteServices.length === 0) return;

  const staleServices = remoteServices.filter(f => !knownServiceFiles.includes(f));

  if (staleServices.length === 0) return;

  printWarning(`Found ${staleServices.length} stale service(s) to remove: ${staleServices.join(', ')}`);

  for (const serviceFile of staleServices) {
    const serviceName = serviceFile.replace('.service', '');
    printInfo(`Removing stale service: ${serviceName}`);
    server.systemctl('stop', serviceName, { check: false });
    server.systemctl('disable', serviceName, { check: false });
    server.sshCmd(`rm -f /etc/systemd/system/${serviceFile}`, { check: false });
  }

  server.sshCmd('systemctl daemon-reload');
  server.sshCmd('systemctl reset-failed', { check: false });
  printStatus(`Removed ${staleServices.length} stale service(s)`);
}

/**
 * Deploy to a local provider (docker-compose-based).
 *
 * Skips all the SSH/systemd/apt/rsync plumbing that doesn't apply on the
 * current machine. The important bits — writing scheduler-config.json so
 * the scheduler knows which jobs to run, and bringing compose services up
 * — still happen.
 */
async function deployLocal(server) {
  const deployPath = server.deployPath;

  // Ensure the .data directory exists for state files
  printInfo(`Deploying to local deployment at ${deployPath}...`);
  fs.mkdirSync(path.join(deployPath, '.data'), { recursive: true });

  // Write deployment name file (used for runtime AI config overrides)
  printInfo(`Setting deployment name: ${server.name}`);
  fs.writeFileSync(path.join(deployPath, '.data', 'deployment-name'), server.name + '\n');

  // Apply deployment-specific AI overrides to config (only if config is NOT in vault)
  const { getConfigPath } = await import('../../config.js');
  const configPath = getConfigPath();
  const relativeConfigPath = configPath.replace(PROJECT_ROOT + '/', '');
  const configInVault = relativeConfigPath.startsWith('vault/');

  if (server.ai && !configInVault && PROJECT_ROOT === deployPath) {
    printInfo('Applying deployment AI configuration...');
    const { applyDeploymentOverrides } = await import('../../config.js');
    applyDeploymentOverrides(server.ai, configPath);
    printStatus('AI configuration applied');
  } else if (server.ai && configInVault) {
    printInfo('AI overrides will be applied at runtime (config in vault)');
  }

  // Write scheduler jobs config from config.toml's [deployments.*.jobs.*]
  if (server.jobs && Object.keys(server.jobs).length > 0) {
    printInfo('Writing scheduler jobs config...');
    const jobsConfigPath = path.join(deployPath, '.data', 'scheduler-config.json');
    fs.writeFileSync(jobsConfigPath, JSON.stringify(server.jobs, null, 2) + '\n');
    printStatus(`Configured ${Object.keys(server.jobs).length} scheduled job(s)`);
  }

  // Bring up enabled compose services. The LocalProvider's systemctl
  // override translates these into `docker compose up -d <name>` calls.
  const enabledServices = Object.entries(server.services || {})
    .filter(([_, enabled]) => enabled)
    .map(([name]) => configKeyToSystemdName(name));

  const startedServices = [];
  const failedServices = [];

  if (enabledServices.length > 0) {
    // Pre-flight: make sure docker is actually available on this machine.
    // If it isn't (common when running `bin/deploy` from inside a
    // devcontainer without docker CLI installed), we fail loudly instead
    // of pretending the services started.
    const dockerCheck = server.sshCmd('command -v docker >/dev/null 2>&1', { check: false });
    if (dockerCheck.returncode !== 0) {
      printError('Docker CLI not found — cannot bring up compose services from this shell.');
      console.log('');
      console.log('The scheduler-config.json and deployment-name files have been written,');
      console.log('but services were not started. Run these from a shell that has docker:');
      console.log('');
      console.log(`  cd ${deployPath}`);
      for (const service of enabledServices) {
        const bare = service === 'today-scheduler' ? 'scheduler' : service;
        console.log(`  docker compose up -d ${bare}`);
      }
      console.log('');
      console.log('If you are inside a devcontainer, either run this from the host shell, or');
      console.log('rebuild the devcontainer with Docker CLI installed and /var/run/docker.sock mounted.');
      process.exit(1);
    }

    printInfo(`Starting configured services: ${enabledServices.join(', ')}`);
    for (const service of enabledServices) {
      // `enable` + `restart` both map to compose commands; restart handles
      // the "already running, pick up new config" case.
      const enableResult = server.systemctl('enable', service, { check: false });
      const restartResult = server.systemctl('restart', service, { check: false });
      if (enableResult.returncode === 0 && restartResult.returncode === 0) {
        startedServices.push(service);
      } else {
        failedServices.push(service);
      }
    }
    if (startedServices.length > 0) {
      printStatus(`Started ${startedServices.length} service(s): ${startedServices.join(', ')}`);
    }
    if (failedServices.length > 0) {
      printError(`Failed to start ${failedServices.length} service(s): ${failedServices.join(', ')}`);
      console.log('  Investigate with: docker compose logs <service>');
      process.exit(1);
    }
  } else {
    printInfo('No services configured. Enable in config.toml under [deployments.local.*.services]');
  }

  printStatus('Local deployment complete!');
  console.log('');
  console.log(`  Deploy path: ${deployPath}`);
  if (startedServices.length > 0) {
    console.log(`  Services:    ${startedServices.join(', ')}`);
    console.log(`  Logs:        docker compose logs -f <service>`);
  }
}

export default deployCommand;
