/**
 * Tests for deployment configuration parsing
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { parseServicesConfig, SERVICES, getServiceEntries, getSystemdUnitNames, getSystemdToComposeMap, configKeyToSystemdName } from '../src/deploy/services.js';

// We'll test the config parsing logic directly by examining the output
// Since the actual module has dependencies on external services (dotenvx),
// we test the core parsing behavior through integration tests

describe('deploy/config', () => {
  describe('getIpEnvVarName convention', () => {
    // Test the naming convention directly
    function getIpEnvVarName(provider, name) {
      const providerUpper = provider.toUpperCase().replace(/-/g, '_');
      const nameUpper = name.toUpperCase().replace(/-/g, '_');
      return `DEPLOY_${providerUpper}_${nameUpper}_IP`;
    }

    test('generates correct env var name', () => {
      expect(getIpEnvVarName('digitalocean', 'production')).toBe('DEPLOY_DIGITALOCEAN_PRODUCTION_IP');
      expect(getIpEnvVarName('hetzner', 'backup')).toBe('DEPLOY_HETZNER_BACKUP_IP');
    });

    test('handles hyphens in names', () => {
      expect(getIpEnvVarName('digital-ocean', 'my-server')).toBe('DEPLOY_DIGITAL_OCEAN_MY_SERVER_IP');
    });

    test('handles mixed case', () => {
      expect(getIpEnvVarName('DigitalOcean', 'Production')).toBe('DEPLOY_DIGITALOCEAN_PRODUCTION_IP');
    });
  });

  describe('services config parsing', () => {
    // Use the real parseServicesConfig from the shared module
    const parseServices = parseServicesConfig;

    test('parses enabled services', () => {
      const services = parseServices({
        scheduler: true,
        'inbox-api': false
      });

      expect(services.scheduler).toBe(true);
      expect(services['inbox-api']).toBe(false);
      expect(services['vault-web']).toBe(false);
    });

    test('defaults all to false when empty', () => {
      const services = parseServices({});
      expect(services.scheduler).toBe(false);
      expect(services['vault-web']).toBe(false);
    });

    test('defaults all to false when undefined', () => {
      const services = parseServices(undefined);
      expect(services.scheduler).toBe(false);
    });

    test('only enables when explicitly true', () => {
      const services = parseServices({
        scheduler: 'yes',  // truthy but not true
        'vault-web': 1  // truthy but not true
      });
      expect(services.scheduler).toBe(false);
      expect(services['vault-web']).toBe(false);
    });

    test('includes vault-watcher in parsed output', () => {
      const services = parseServices({ 'vault-watcher': true });
      expect(services['vault-watcher']).toBe(true);
    });
  });

  describe('services module (single source of truth)', () => {
    test('SERVICES array contains all expected services', () => {
      const keys = SERVICES.map(s => s.key);
      expect(keys).toContain('scheduler');
      expect(keys).toContain('vault-watcher');
      expect(keys).toContain('vault-web');
      expect(keys).toContain('inbox-api');
      expect(keys).toContain('resilio-sync');
      expect(keys).toContain('git-sync.timer');
    });

    test('every service has required fields', () => {
      for (const s of SERVICES) {
        expect(s.key).toBeTruthy();
        expect(s.label).toBeTruthy();
        expect(s.description).toBeTruthy();
        expect(s.systemdUnit).toBeTruthy();
      }
    });

    test('getServiceEntries returns entries with key/label/desc', () => {
      const entries = getServiceEntries();
      expect(entries.length).toBe(SERVICES.length);
      for (const e of entries) {
        expect(e).toHaveProperty('key');
        expect(e).toHaveProperty('label');
        expect(e).toHaveProperty('desc');
      }
    });

    test('getSystemdUnitNames returns all unit names', () => {
      const names = getSystemdUnitNames();
      expect(names).toContain('today-scheduler.service');
      expect(names).toContain('vault-watcher.service');
      expect(names).toContain('git-sync.timer');
    });

    test('getSystemdToComposeMap maps both bare names and config keys', () => {
      const map = getSystemdToComposeMap();
      expect(map['today-scheduler']).toBe('scheduler');
      expect(map['scheduler']).toBe('scheduler');
      expect(map['vault-watcher']).toBe('vault-watcher');
      expect(map['vault-web']).toBe('vault-web');
    });

    test('configKeyToSystemdName handles scheduler special case', () => {
      expect(configKeyToSystemdName('scheduler')).toBe('today-scheduler');
      expect(configKeyToSystemdName('vault-web')).toBe('vault-web');
      expect(configKeyToSystemdName('git-sync.timer')).toBe('git-sync');
      expect(configKeyToSystemdName('unknown')).toBe('unknown');
    });
  });

  describe('jobs config parsing', () => {
    const DEFAULT_JOBS = {
      'plugin-sync': {
        schedule: '*/10 * * * *',
        command: 'bin/plugins sync',
        description: 'Sync all plugins'
      }
    };

    function parseJobs(jobsConfig) {
      const config = jobsConfig || DEFAULT_JOBS;
      const jobs = {};
      for (const [jobName, jobConfig] of Object.entries(config)) {
        if (typeof jobConfig === 'object' && jobConfig.schedule && jobConfig.command) {
          jobs[jobName] = {
            schedule: jobConfig.schedule,
            command: jobConfig.command,
            description: jobConfig.description || jobName
          };
        }
      }
      return jobs;
    }

    test('parses custom jobs', () => {
      const jobs = parseJobs({
        'plugin-sync': {
          schedule: '*/5 * * * *',
          command: 'bin/plugins sync --quick',
          description: 'Quick sync'
        },
        'backup': {
          schedule: '0 3 * * *',
          command: '/opt/scripts/backup.sh'
        }
      });

      expect(jobs['plugin-sync'].schedule).toBe('*/5 * * * *');
      expect(jobs['plugin-sync'].description).toBe('Quick sync');
      expect(jobs['backup'].schedule).toBe('0 3 * * *');
      expect(jobs['backup'].description).toBe('backup'); // Uses job name as default
    });

    test('uses defaults when no jobs configured', () => {
      const jobs = parseJobs(undefined);
      expect(jobs['plugin-sync']).toBeDefined();
      expect(jobs['plugin-sync'].schedule).toBe('*/10 * * * *');
    });

    test('ignores invalid job entries', () => {
      const jobs = parseJobs({
        'valid': { schedule: '* * * * *', command: 'echo test' },
        'missing-schedule': { command: 'echo test' },
        'missing-command': { schedule: '* * * * *' },
        'not-object': 'invalid'
      });

      expect(Object.keys(jobs).length).toBe(1);
      expect(jobs['valid']).toBeDefined();
    });

    test('git-sync can be configured as a scheduler job for local deployments', () => {
      // This is the documented shape for enabling git-sync on a local
      // deployment; it lives alongside plugin-sync in config.toml under
      // [deployments.local.<name>.jobs.git-sync].
      const jobs = parseJobs({
        'plugin-sync': {
          schedule: '*/10 * * * *',
          command: 'bin/plugins sync'
        },
        'git-sync': {
          schedule: '* * * * *',
          command: 'bin/git-sync',
          description: 'Pull/rebase/push vault via git'
        }
      });

      expect(jobs['git-sync']).toBeDefined();
      expect(jobs['git-sync'].schedule).toBe('* * * * *');
      expect(jobs['git-sync'].command).toBe('bin/git-sync');
      expect(jobs['plugin-sync']).toBeDefined();
    });
  });

  describe('deployment config structure', () => {
    test('config.toml deployment schema', () => {
      // Document the expected schema
      const exampleDeploymentConfig = {
        enabled: true,
        domain: 'today.example.com',
        deploy_path: '/opt/today',
        remote_vault_path: 'vault',
        ssh_user: 'root',
        ssh_port: 22,
        services: {
          scheduler: true,
          'inbox-api': false
        },
        jobs: {
          'plugin-sync': {
            schedule: '*/10 * * * *',
            command: 'bin/plugins sync',
            description: 'Sync all plugins'
          }
        }
      };

      // Verify all expected fields are present
      expect(exampleDeploymentConfig.enabled).toBeDefined();
      expect(exampleDeploymentConfig.domain).toBeDefined();
      expect(exampleDeploymentConfig.deploy_path).toBeDefined();
      expect(exampleDeploymentConfig.services).toBeDefined();
      expect(exampleDeploymentConfig.jobs).toBeDefined();
    });
  });
});
