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
    
    // Simple TOML parser for our basic config
    const config = {};
    const lines = configContent.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const match = trimmed.match(/^(\w+)\s*=\s*"([^"]+)"/);
        if (match) {
          config[match[1]] = match[2];
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
  return config[key];
}