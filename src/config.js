// Configuration helper for JavaScript modules
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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

    // Simple TOML parser for our config (supports sections and top-level keys)
    const config = {};
    const lines = configContent.split('\n');
    let currentSection = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Check for section header [section] or [section.subsection]
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        // Create nested object for section
        const parts = currentSection.split('.');
        let obj = config;
        for (const part of parts) {
          if (!obj[part]) obj[part] = {};
          obj = obj[part];
        }
        continue;
      }

      // Parse key = value (supports strings, numbers, booleans, arrays)
      const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (match) {
        const key = match[1];
        let value = match[2].trim();

        // Parse the value
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        } else if (value === 'true') {
          value = true;
        } else if (value === 'false') {
          value = false;
        } else if (!isNaN(value) && value !== '') {
          value = Number(value);
        } else if (value.startsWith('[')) {
          // Basic array parsing (assumes string arrays)
          try {
            value = JSON.parse(value.replace(/'/g, '"'));
          } catch {
            // Keep as string if parsing fails
          }
        }

        if (currentSection) {
          // Set in section
          const parts = currentSection.split('.');
          let obj = config;
          for (const part of parts) {
            obj = obj[part];
          }
          obj[key] = value;
        } else {
          // Top-level key
          config[key] = value;
        }
      }
    }

    configCache = config;
    lastReadTime = now;
    return config;
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

export function getClaudeModel() {
  // Priority: config.toml > env var > default
  const configModel = getConfig('ai.claude_model');
  if (configModel) return configModel;
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;
  return 'claude-sonnet-4-20250514';
}