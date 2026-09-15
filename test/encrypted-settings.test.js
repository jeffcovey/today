/**
 * Regression tests for issue #470 — `bin/plugins configure <name>` wrote
 * settings declared `encrypted = true` into the config file in plaintext.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getEncryptedEnvVarName,
  getEncryptedEnvVarNames,
  stripEncryptedSettings
} from '../src/encrypted-settings.js';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('encrypted settings', () => {
  describe('getEncryptedEnvVarName', () => {
    // The formula is a persistence contract: change it and every already-stored
    // secret becomes unreadable, because plugin-loader looks the value up by name.
    test('matches the documented TODAY_<PLUGIN>_<SOURCE>_<SETTING> format', () => {
      expect(getEncryptedEnvVarName('imap-email', 'work', 'password'))
        .toBe('TODAY_IMAP_EMAIL_WORK_PASSWORD');
      expect(getEncryptedEnvVarName('ynab-api', 'default', 'api_token'))
        .toBe('TODAY_YNAB_API_DEFAULT_API_TOKEN');
    });

    test('sanitizes every non-alphanumeric character', () => {
      expect(getEncryptedEnvVarName('a.b-c', 'x/y', 'k l'))
        .toBe('TODAY_A_B_C_X_Y_K_L');
    });
  });

  describe('stripEncryptedSettings', () => {
    const settings = {
      api_token: { type: 'string', encrypted: true },
      password: { type: 'string', encrypted: true },
      retention_days: { type: 'number' },
      enabled_flag: { type: 'boolean', encrypted: false }
    };

    test('removes encrypted values so they cannot reach the config file', () => {
      const cleaned = stripEncryptedSettings(settings, {
        enabled: true,
        api_token: 'super-secret-token',
        password: 'hunter2',
        retention_days: 365
      });

      expect(cleaned).not.toHaveProperty('api_token');
      expect(cleaned).not.toHaveProperty('password');
      expect(JSON.stringify(cleaned)).not.toContain('super-secret-token');
      expect(JSON.stringify(cleaned)).not.toContain('hunter2');
    });

    test('preserves non-encrypted values', () => {
      const cleaned = stripEncryptedSettings(settings, {
        enabled: true,
        retention_days: 365,
        enabled_flag: false
      });

      expect(cleaned).toEqual({ enabled: true, retention_days: 365, enabled_flag: false });
    });

    test('tolerates missing settings definitions', () => {
      expect(stripEncryptedSettings(null, { a: 1 })).toEqual({ a: 1 });
      expect(stripEncryptedSettings(undefined, { a: 1 })).toEqual({ a: 1 });
    });

    test('does not mutate the input', () => {
      const input = { api_token: 'secret', retention_days: 1 };
      stripEncryptedSettings(settings, input);
      expect(input.api_token).toBe('secret');
    });
  });

  describe('getEncryptedEnvVarNames', () => {
    test('lists only encrypted setting env vars for a source', () => {
      expect(getEncryptedEnvVarNames('ynab-api', 'default', {
        api_token: { encrypted: true },
        budget_id: { encrypted: false },
        password: { encrypted: true }
      })).toEqual([
        'TODAY_YNAB_API_DEFAULT_API_TOKEN',
        'TODAY_YNAB_API_DEFAULT_PASSWORD'
      ]);
    });
  });

  describe('bin/plugins prompt paths', () => {
    // The original bug: addSource/editSource looped over plugin.settings with no
    // awareness of `encrypted`, so secrets went straight into the config file.
    const source = fs.readFileSync(path.join(projectRoot, 'bin', 'plugins'), 'utf8');

    const bodyOf = (fnName) => {
      const start = source.indexOf(`async function ${fnName}(`) >= 0
        ? source.indexOf(`async function ${fnName}(`)
        : source.indexOf(`function ${fnName}(`);
      expect(start).toBeGreaterThan(-1);
      const nextAsync = source.indexOf('\nasync function ', start + 1);
      const nextSync = source.indexOf('\nfunction ', start + 1);
      const nextCandidates = [nextAsync, nextSync].filter(i => i !== -1);
      const next = nextCandidates.length > 0 ? Math.min(...nextCandidates) : -1;
      return source.slice(start, next === -1 ? source.length : next);
    };

    test.each(['addSource', 'editSource'])('%s branches on schema.encrypted', (fn) => {
      expect(bodyOf(fn)).toContain('schema.encrypted');
    });

    test.each(['addSource', 'editSource'])('%s strips encrypted keys before saving', (fn) => {
      expect(bodyOf(fn)).toContain('stripEncryptedSettings');
    });

    test.each(['addSource', 'editSource'])('%s rolls back encrypted writes when later prompts abort', (fn) => {
      expect(bodyOf(fn)).toContain('rollbackEncryptedSettingChanges');
    });

    test.each(['addSource', 'editSource'])('%s rolls back encrypted writes when the config CAS write conflicts', (fn) => {
      const body = bodyOf(fn);
      expect(body).toContain('if (!saveSourceConfig(');
      expect(body).toContain('rollbackEncryptedSettingChanges(encryptedSettingBackups);');
    });

    test('rollbackEncryptedSettingChanges surfaces rollback failures', () => {
      expect(bodyOf('rollbackEncryptedSettingChanges')).toContain('rollbackEncryptedSettingBackups');
      expect(bodyOf('rollbackEncryptedSettingChanges')).toContain('p.log.error');
      expect(bodyOf('rollbackEncryptedSettingChanges')).toContain('Check .env manually.');
    });

    test('every saveSourceConfig call is guarded by stripEncryptedSettings', () => {
      const calls = source.split('\n').filter(
        l => l.includes('saveSourceConfig(') && !l.includes('function saveSourceConfig')
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toContain('stripEncryptedSettings');
      }
    });

    test('removeSource uses the shared delete helper and reports orphaned secrets', () => {
      const body = bodyOf('removeSource');
      expect(body).toContain('deleteSourceConfigWithSecrets(');
      expect(body).toContain('secret may be left behind:');
      expect(body).toContain('Check .env.');
    });

    test('removeSource persists via writeConfigToml before secret cleanup can run', () => {
      const body = bodyOf('removeSource');
      expect(body).toContain('persist: (nextConfig) =>');
      expect(body).toContain('writeConfigToml(');
      expect(body).toContain("stage === 'clear'");
    });
  });

  describe('plugins-configure-ui delete path', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src', 'plugins-configure-ui.js'), 'utf8');

    test('deleteSource uses the shared delete helper with a persist callback', () => {
      expect(source).toContain('deleteSourceConfigWithSecrets(config, pluginName, sourceName, pluginSettings, {');
      expect(source).toContain('persist: (nextConfig) => {');
      expect(source).toContain('const result = deleteSource(pluginName, selectedSource.sourceName, plugin.settings);');
    });

    test('delete confirmation reports orphaned secrets after a successful persist', () => {
      expect(source).toContain("result.stage === 'clear'");
      expect(source).toContain('secret may be left behind:');
      expect(source).toContain('Check .env.');
    });
  });
});
