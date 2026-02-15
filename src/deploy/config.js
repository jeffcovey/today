/**
 * Deployment configuration loader
 *
 * Reads deployment configurations from config.toml and resolves
 * environment variables for sensitive data (IPs, passwords, etc.)
 */

import { execSync } from 'child_process';
import { getFullConfig } from '../config.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

/**
 * Get an environment variable (decrypted if using dotenvx)
 */
function getEnvVar(key) {
  // First check process.env
  if (process.env[key]) {
    return process.env[key];
  }

  // Try to get from dotenvx
  try {
    const result = execSync(`npx dotenvx get ${key} 2>/dev/null`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the environment variable name for a deployment's IP
 * Convention: DEPLOY_{PROVIDER}_{NAME}_IP (uppercase, underscores)
 */
export function getIpEnvVarName(provider, name) {
  const providerUpper = provider.toUpperCase().replace(/-/g, '_');
  const nameUpper = name.toUpperCase().replace(/-/g, '_');
  return `DEPLOY_${providerUpper}_${nameUpper}_IP`;
}

/**
 * Legacy env var name mapping for backwards compatibility
 */
const LEGACY_ENV_VARS = {
  'digitalocean': {
    'production': 'DO_DROPLET_IP',
    'default': 'DO_DROPLET_IP'
  }
};

/**
 * Get the IP address for a deployment
 */
function getDeploymentIp(provider, name) {
  // Try new naming convention first
  const newEnvVar = getIpEnvVarName(provider, name);
  let ip = getEnvVar(newEnvVar);
  if (ip) return ip;

  // Try legacy naming for backwards compatibility
  const legacyVars = LEGACY_ENV_VARS[provider];
  if (legacyVars) {
    const legacyVar = legacyVars[name] || legacyVars.default;
    if (legacyVar) {
      ip = getEnvVar(legacyVar);
      if (ip) return ip;
    }
  }

  return null;
}

/**
 * Default jobs for new deployments
 */
const DEFAULT_JOBS = {
  'plugin-sync': {
    schedule: '*/10 * * * *',
    command: 'bin/plugins sync',
    description: 'Sync all plugins'
  }
};

/**
 * Parse deployment configuration from config.toml
 *
 * Config format:
 * [deployments.{provider}.{name}]
 * enabled = true
 * domain = "example.com"
 * deploy_path = "/opt/today"
 * remote_vault_path = "vault"
 * ssh_user = "root"
 * ssh_port = 22
 *
 * [deployments.{provider}.{name}.services]
 * scheduler = true
 * inbox-api = false
 *
 * [deployments.{provider}.{name}.jobs]
 * plugin-sync = { schedule = "...", command = "bin/plugins sync" }
 */
export function getDeployments() {
  const config = getFullConfig();
  const deploymentsConfig = config.deployments || {};
  const deployments = [];

  for (const [provider, providerDeployments] of Object.entries(deploymentsConfig)) {
    for (const [name, deploymentConfig] of Object.entries(providerDeployments)) {
      // Skip if explicitly disabled
      if (deploymentConfig.enabled === false) {
        continue;
      }

      const ip = getDeploymentIp(provider, name);

      // Parse services config (default all to false for safety)
      const servicesConfig = deploymentConfig.services || {};
      const services = {
        scheduler: servicesConfig.scheduler === true,
        'vault-web': servicesConfig['vault-web'] === true,
        'inbox-api': servicesConfig['inbox-api'] === true,
        'resilio-sync': servicesConfig['resilio-sync'] === true
      };

      // Parse jobs config (use defaults if not specified)
      const jobsConfig = deploymentConfig.jobs || DEFAULT_JOBS;
      const jobs = {};
      for (const [jobName, jobConfig] of Object.entries(jobsConfig)) {
        if (typeof jobConfig === 'object' && jobConfig.schedule && jobConfig.command) {
          jobs[jobName] = {
            schedule: jobConfig.schedule,
            command: jobConfig.command,
            description: jobConfig.description || jobName
          };
        }
      }

      deployments.push({
        name,
        provider,
        ip,
        enabled: deploymentConfig.enabled !== false,
        domain: deploymentConfig.domain || null,
        deployPath: deploymentConfig.deploy_path || '/opt/today',
        remoteVaultPath: deploymentConfig.remote_vault_path || 'vault',
        sshUser: deploymentConfig.ssh_user || 'root',
        sshPort: deploymentConfig.ssh_port || 22,
        sshKeyPath: deploymentConfig.ssh_key_path || null,
        adminEmail: deploymentConfig.admin_email || config.profile?.email || 'admin@example.com',
        services,
        jobs,
        // Provider-specific settings (exclude parsed sections)
        ...Object.fromEntries(
          Object.entries(deploymentConfig).filter(([k]) => !['services', 'jobs'].includes(k))
        )
      });
    }
  }

  return deployments;
}

/**
 * Get all enabled deployments
 */
export function getEnabledDeployments() {
  return getDeployments().filter(d => d.enabled);
}

/**
 * Get a specific deployment by name
 */
export function getDeployment(name) {
  const deployments = getDeployments();

  // Exact match on name
  const exact = deployments.find(d => d.name === name);
  if (exact) return exact;

  // Try provider/name format
  if (name.includes('/')) {
    const [provider, deployName] = name.split('/');
    return deployments.find(d => d.provider === provider && d.name === deployName);
  }

  return null;
}

/**
 * Get deployment by provider and name
 */
export function getDeploymentByProviderAndName(provider, name) {
  const deployments = getDeployments();
  return deployments.find(d => d.provider === provider && d.name === name);
}

/**
 * List all deployments with their status
 */
export function listDeployments() {
  const deployments = getDeployments();

  if (deployments.length === 0) {
    console.log('No deployments configured.');
    console.log('');
    console.log('Add a deployment in config.toml:');
    console.log('');
    console.log('[deployments.digitalocean.production]');
    console.log('enabled = true');
    console.log('domain = "today.example.com"');
    console.log('deploy_path = "/opt/today"');
    console.log('');
    console.log('Then set the server IP:');
    console.log('npx dotenvx set DEPLOY_DIGITALOCEAN_PRODUCTION_IP "xxx.xxx.xxx.xxx"');
    return;
  }

  console.log('Configured deployments:');
  console.log('');

  for (const d of deployments) {
    const status = d.enabled ? (d.ip ? '✓' : '⚠') : '○';
    const statusColor = d.enabled ? (d.ip ? '\x1b[32m' : '\x1b[33m') : '\x1b[90m';
    const reset = '\x1b[0m';

    console.log(`${statusColor}${status}${reset} ${d.provider}/${d.name}`);
    console.log(`    Domain: ${d.domain || '(none)'}`);
    console.log(`    Server: ${d.ip || '(not configured)'}`);
    console.log(`    Path: ${d.deployPath}`);
    if (!d.enabled) {
      console.log(`    Status: disabled`);
    } else if (!d.ip) {
      const envVar = getIpEnvVarName(d.provider, d.name);
      console.log(`    Status: missing IP (set ${envVar})`);
    }
    console.log('');
  }
}

/**
 * Check if any deployments are configured
 */
export function hasDeployments() {
  return getDeployments().length > 0;
}

/**
 * Get the default deployment (first enabled one with an IP)
 */
export function getDefaultDeployment() {
  const deployments = getEnabledDeployments();
  return deployments.find(d => d.ip) || deployments[0] || null;
}

export default {
  getDeployments,
  getEnabledDeployments,
  getDeployment,
  getDeploymentByProviderAndName,
  listDeployments,
  hasDeployments,
  getDefaultDeployment,
  getIpEnvVarName
};
