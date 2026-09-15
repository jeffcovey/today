/**
 * Encrypted plugin settings — the single owner of the `encrypted = true` contract.
 *
 * Any code path that reads or writes a secret declared `encrypted = true` in a
 * plugin.toml MUST go through this module. The env-var naming formula used to be
 * copied into each caller, which is how `bin/plugins configure <name>` shipped
 * writing secrets in plaintext while the TUI encrypted them (issue #470).
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);
const ENV_PATH = path.join(projectRoot, '.env');

/**
 * Build the env var name holding an encrypted setting.
 * e.g. ("imap-email", "personal", "password") -> "TODAY_IMAP_EMAIL_PERSONAL_PASSWORD"
 */
export function getEncryptedEnvVarName(pluginName, sourceName, settingKey) {
  const sanitize = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `TODAY_${sanitize(pluginName)}_${sanitize(sourceName)}_${sanitize(settingKey)}`;
}

/** Read and decrypt an env var. Returns null when unset. */
export function getEnvVar(key) {
  try {
    const result = execSync(`npx dotenvx get ${key} 2>/dev/null`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** Write an env var, always encrypted. Creates .env (and .env.keys via dotenvx) as needed. */
export function setEnvVar(key, value) {
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, '# Environment variables for Today\n\n');
  }

  const escapedValue = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');

  try {
    execSync(`npx dotenvx set ${key} "${escapedValue}"`, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch (error) {
    console.error(`Failed to set ${key}:`, error.message);
    return false;
  }
}

/** True when the env var holds a value. */
export function hasEnvVar(key) {
  return getEnvVar(key) !== null;
}

/** Delete an env var so old encrypted settings cannot be reused later. */
export function clearEnvVar(key) {
  try {
    execSync(`npx dotenvx del ${key}`, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch (error) {
    console.error(`Failed to clear ${key}:`, error.message);
    return false;
  }
}

/**
 * Strip every `encrypted = true` setting out of a source config object.
 *
 * Callers building a config to persist run it through this so a secret can
 * never reach the config file, even if an earlier version wrote one there or a
 * prompt loop sets it by mistake.
 */
export function stripEncryptedSettings(pluginSettings, sourceConfig) {
  const cleaned = { ...sourceConfig };
  for (const [key, def] of Object.entries(pluginSettings || {})) {
    if (def?.encrypted) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

/** List env vars that back a plugin source's encrypted settings. */
export function getEncryptedEnvVarNames(pluginName, sourceName, pluginSettings) {
  const names = [];
  for (const [key, def] of Object.entries(pluginSettings || {})) {
    if (def?.encrypted) {
      names.push(getEncryptedEnvVarName(pluginName, sourceName, key));
    }
  }
  return names;
}

/** Clear all encrypted settings for a plugin source so old secrets cannot be reused. */
export function clearEncryptedSettings(pluginName, sourceName, pluginSettings) {
  let allCleared = true;
  for (const envVarName of getEncryptedEnvVarNames(pluginName, sourceName, pluginSettings)) {
    if (!clearEnvVar(envVarName)) {
      allCleared = false;
    }
  }
  return allCleared;
}

/** Restore encrypted env vars after a canceled or failed configuration flow. */
export function rollbackEncryptedSettingBackups(
  encryptedSettingBackups,
  { clear = clearEnvVar, set = setEnvVar } = {}
) {
  const failures = [];
  for (const [envVarName, previousValue] of encryptedSettingBackups.entries()) {
    const ok = previousValue === null
      ? clear(envVarName)
      : set(envVarName, previousValue);
    if (ok !== true) {
      failures.push(envVarName);
    }
  }
  return failures;
}

/** Remove a source from config only after its encrypted settings are cleared. */
export function deleteSourceConfigWithSecrets(
  config,
  pluginName,
  sourceName,
  pluginSettings,
  clearSettings = clearEncryptedSettings
) {
  if (!config.plugins?.[pluginName]?.[sourceName]) {
    return true;
  }

  if (!clearSettings(pluginName, sourceName, pluginSettings)) {
    return false;
  }

  delete config.plugins[pluginName][sourceName];
  if (Object.keys(config.plugins[pluginName]).length === 0) {
    delete config.plugins[pluginName];
  }

  return true;
}
