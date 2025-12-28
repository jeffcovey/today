// Configuration helper for JavaScript modules
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parse } from 'smol-toml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let configCache = null;
let lastReadTime = 0;
const CACHE_TTL = 60000; // Cache for 1 minute

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
  } catch (error) {
    console.error('Error reading config.toml:', error);
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