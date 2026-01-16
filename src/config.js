// Configuration helper for JavaScript modules
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parse, stringify } from 'smol-toml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let configCache = null;
let lastReadTime = 0;
const CACHE_TTL = 60000; // Cache for 1 minute

/**
 * Check if config.toml exists
 */
export function configExists() {
  const configPath = join(__dirname, '..', 'config.toml');
  return existsSync(configPath);
}

function readConfig() {
  const now = Date.now();
  if (configCache && (now - lastReadTime) < CACHE_TTL) {
    return configCache;
  }

  try {
    const configPath = join(__dirname, '..', 'config.toml');
    const configContent = readFileSync(configPath, 'utf8');
    configCache = parse(configContent);
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
  const configPath = join(__dirname, '..', 'config.toml');
  const config = parse(readFileSync(configPath, 'utf8'));

  // Apply AI overrides
  if (!config.ai) config.ai = {};
  for (const [key, value] of Object.entries(aiOverrides)) {
    if (value !== undefined && value !== null) {
      config.ai[key] = value;
    }
  }

  writeFileSync(outputPath, stringify(config));
}