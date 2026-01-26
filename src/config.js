// Configuration helper for JavaScript modules
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parse, stringify } from 'smol-toml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

let configCache = null;
let lastReadTime = 0;
const CACHE_TTL = 60000; // Cache for 1 minute

const CONFIG_PATH_FILE = join(PROJECT_ROOT, '.data', 'config-path');

/**
 * Resolve a config path (handles absolute and relative paths).
 */
function resolveConfigPath(configPath) {
  if (configPath.startsWith('/')) {
    return configPath;
  }
  return join(PROJECT_ROOT, configPath);
}

/**
 * Get the config file path.
 * Priority: TODAY_CONFIG env var → .data/config-path file → default config.toml
 * Supports absolute paths or paths relative to project root.
 */
export function getConfigPath() {
  // 1. Environment variable takes precedence (for deployments)
  if (process.env.TODAY_CONFIG) {
    return resolveConfigPath(process.env.TODAY_CONFIG);
  }

  // 2. Check .data/config-path bootstrap file
  try {
    if (existsSync(CONFIG_PATH_FILE)) {
      const customPath = readFileSync(CONFIG_PATH_FILE, 'utf8').trim();
      if (customPath) {
        return resolveConfigPath(customPath);
      }
    }
  } catch {
    // Ignore errors, fall through to default
  }

  // 3. Default location
  return join(PROJECT_ROOT, 'config.toml');
}

/**
 * Set the config file path (writes to .data/config-path).
 * Pass empty string or null to reset to default.
 */
export function setConfigPath(configPath) {
  const dataDir = join(PROJECT_ROOT, '.data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  if (!configPath || configPath === 'config.toml') {
    // Reset to default - remove the file
    try {
      unlinkSync(CONFIG_PATH_FILE);
    } catch {
      // Ignore if file doesn't exist
    }
  } else {
    writeFileSync(CONFIG_PATH_FILE, configPath.trim() + '\n');
  }
}

/**
 * Check if config.toml exists
 */
export function configExists() {
  return existsSync(getConfigPath());
}

const DEPLOYMENT_NAME_FILE = join(PROJECT_ROOT, '.data', 'deployment-name');

/**
 * Get the current deployment name (if running on a deployed server).
 */
export function getDeploymentName() {
  try {
    if (existsSync(DEPLOYMENT_NAME_FILE)) {
      return readFileSync(DEPLOYMENT_NAME_FILE, 'utf8').trim();
    }
  } catch {
    // Ignore
  }
  return null;
}

function readConfig() {
  const now = Date.now();
  if (configCache && (now - lastReadTime) < CACHE_TTL) {
    return configCache;
  }

  try {
    const configContent = readFileSync(getConfigPath(), 'utf8');
    let config = parse(configContent);

    // Apply deployment-specific AI overrides at runtime
    const deploymentName = getDeploymentName();
    if (deploymentName && config.deployments) {
      // Find matching deployment config (e.g., deployments.digitalocean.droplet)
      for (const provider of Object.keys(config.deployments)) {
        const providerConfig = config.deployments[provider];
        if (providerConfig[deploymentName]?.ai) {
          // Merge deployment AI settings into main ai config
          config.ai = { ...config.ai, ...providerConfig[deploymentName].ai };
          break;
        }
      }
    }

    configCache = config;
    lastReadTime = now;
    return configCache;
  } catch {
    // Return defaults if config can't be read
    return {
      timezone: 'America/New_York'
    };
  }
}

export function getTimezone() {
  const config = readConfig();
  return config.timezone || 'America/New_York';
}

export function getFullConfig() {
  return readConfig();
}

export function getConfig(key) {
  const config = readConfig();
  // Support dot notation (e.g., 'ai.claude_model')
  if (key.includes('.')) {
    const parts = key.split('.');
    let value = config;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return undefined;
      }
    }
    return value;
  }
  return config[key];
}

/**
 * Get the model for interactive Claude Code CLI sessions.
 * Returns model aliases like 'opus', 'sonnet', 'haiku'.
 */
export function getInteractiveModel() {
  const configModel = getConfig('ai.interactive_model');
  if (configModel) return configModel;
  return 'sonnet';
}

/**
 * Get the model for API calls.
 * Returns full model names like 'claude-sonnet-4-20250514'.
 * @deprecated Use ai-provider.js instead for provider-agnostic AI access
 */
export function getApiModel() {
  const configModel = getConfig('ai.model');
  if (configModel) return configModel;
  // Legacy fallbacks
  const legacyModel = getConfig('ai.claude_model') || getConfig('ai.api_model');
  if (legacyModel) return legacyModel;
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;
  return 'claude-sonnet-4-20250514';
}

/**
 * @deprecated Use ai-provider.js instead
 */
export function getClaudeModel() {
  return getApiModel();
}

/**
 * Get the vault path (directory for markdown notes).
 * Returns configured path or 'vault' as default.
 */
export function getVaultPath() {
  const config = readConfig();
  return config.vault_path || 'vault';
}

/**
 * Get the absolute vault path.
 */
export function getAbsoluteVaultPath() {
  const projectRoot = join(__dirname, '..');
  return join(projectRoot, getVaultPath());
}

/**
 * Get all focus presets from config.
 * Returns an object mapping preset names to their config.
 */
export function getFocusPresets() {
  const config = readConfig();
  return config.focus || {};
}

/**
 * Get a specific focus preset by name.
 * Returns { description, instructions } or undefined if not found.
 */
export function getFocusPreset(name) {
  const presets = getFocusPresets();
  return presets[name];
}

/**
 * Apply deployment-specific AI overrides and write to a new config file.
 * Used during deployment to customize AI settings per server.
 * @param {Object} aiOverrides - AI settings to override (provider, model, etc.)
 * @param {string} outputPath - Path to write the modified config
 */
export function applyDeploymentOverrides(aiOverrides, outputPath) {
  const config = parse(readFileSync(getConfigPath(), 'utf8'));

  // Apply AI overrides
  if (!config.ai) config.ai = {};
  for (const [key, value] of Object.entries(aiOverrides)) {
    if (value !== undefined && value !== null) {
      config.ai[key] = value;
    }
  }

  writeFileSync(outputPath, stringify(config));
}