/**
 * Canonical list of Today services.
 *
 * Every piece of code that needs to know "what services exist" imports from
 * here instead of maintaining its own hardcoded list. Adding a new service
 * is a one-line change to the SERVICES array below; all call sites pick it
 * up automatically.
 *
 * Previously this list was duplicated across six files with subtly different
 * contents — see #214 for the full audit.
 */

/**
 * @typedef {Object} ServiceDefinition
 * @property {string} key - config.toml key under [deployments.*.services]
 * @property {string} label - Human-readable name for the configure UI
 * @property {string} description - Short description for the configure UI
 * @property {string} systemdUnit - systemd unit name (e.g. 'today-scheduler.service')
 * @property {string|null} composeService - docker-compose service name, or null if not compose-managed
 */

/** @type {ServiceDefinition[]} */
export const SERVICES = [
  {
    key: 'scheduler',
    label: 'Scheduler',
    description: 'Run scheduled jobs',
    systemdUnit: 'today-scheduler.service',
    composeService: 'scheduler',
  },
  {
    key: 'vault-watcher',
    label: 'Vault Watcher',
    description: 'Auto-commit vault changes as they happen',
    systemdUnit: 'vault-watcher.service',
    composeService: 'vault-watcher',
  },
  {
    key: 'vault-web',
    label: 'Vault Web',
    description: 'Serve vault as static site',
    systemdUnit: 'vault-web.service',
    composeService: 'vault-web',
  },
  {
    key: 'inbox-api',
    label: 'Inbox API',
    description: 'Receive uploads from mobile',
    systemdUnit: 'inbox-api.service',
    composeService: 'inbox-api',
  },
  {
    key: 'resilio-sync',
    label: 'Resilio Sync',
    description: 'Peer-to-peer vault sync via Resilio daemon',
    systemdUnit: 'resilio-sync.service',
    composeService: null,
  },
  {
    key: 'git-sync.timer',
    label: 'Git Sync',
    description: 'Sync committed git state via GitHub',
    systemdUnit: 'git-sync.timer',
    composeService: null,
  },
];

/**
 * Parse a services config block from config.toml into a normalized object.
 * Used by deploy/config.js and tests.
 *
 * @param {Object} servicesConfig - Raw [deployments.*.services] from config.toml
 * @returns {Object} { [key]: boolean } for every known service
 */
export function parseServicesConfig(servicesConfig) {
  const config = servicesConfig || {};
  return Object.fromEntries(
    SERVICES.map(s => [s.key, config[s.key] === true])
  );
}

/**
 * Get the list of service keys for the configure UI.
 * @returns {{ key: string, label: string, desc: string }[]}
 */
export function getServiceEntries() {
  return SERVICES.map(s => ({
    key: s.key,
    label: s.label,
    desc: s.description,
  }));
}

/**
 * Get all systemd unit names (for the services management command).
 * @returns {string[]}
 */
export function getSystemdUnitNames() {
  return SERVICES.map(s => s.systemdUnit);
}

/**
 * Build a mapping from bare systemd names to compose service names.
 * Used by the local provider to translate systemctl calls to compose.
 *
 * Maps both the full bare name ('today-scheduler') and the config key
 * ('scheduler') to the compose service name, so either works as input.
 *
 * @returns {Object} { [systemdBareName|configKey]: composeServiceName }
 */
export function getSystemdToComposeMap() {
  const map = {};
  for (const s of SERVICES) {
    if (s.composeService) {
      const bare = s.systemdUnit.replace(/\.(service|timer)$/, '');
      map[bare] = s.composeService;
      map[s.key] = s.composeService;
      map[s.composeService] = s.composeService;
    }
  }
  return map;
}

/**
 * Convert a config.toml service key to its systemd bare name.
 * e.g. 'scheduler' → 'today-scheduler', 'vault-web' → 'vault-web'
 *
 * @param {string} key - Service key from config.toml
 * @returns {string} Bare systemd name (without .service/.timer suffix)
 */
export function configKeyToSystemdName(key) {
  const service = SERVICES.find(s => s.key === key);
  if (!service) return key;
  return service.systemdUnit.replace(/\.(service|timer)$/, '');
}
