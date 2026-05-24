/**
 * Provider registry
 *
 * Maps provider names to their implementation classes
 */

import { DigitalOceanProvider } from './digitalocean.js';
import { HetznerProvider } from './hetzner.js';
import { GenericVpsProvider } from './generic-vps.js';
import { LocalProvider } from './local.js';

export const providers = {
  'digitalocean': DigitalOceanProvider,
  'hetzner': HetznerProvider,
  'generic-vps': GenericVpsProvider,
  'generic': GenericVpsProvider,  // alias
  'vps': GenericVpsProvider,      // alias
  'local': LocalProvider,
};

/**
 * Get a provider class by name
 */
export function getProviderClass(providerName) {
  const Provider = providers[providerName.toLowerCase()];
  if (!Provider) {
    throw new Error(`Unknown provider: ${providerName}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return Provider;
}

/**
 * Create a server instance for a deployment configuration
 */
export function createServer(deploymentConfig) {
  const Provider = getProviderClass(deploymentConfig.provider);
  return new Provider(deploymentConfig);
}

/**
 * List available providers
 */
export function listProviders() {
  return [
    { name: 'digitalocean', label: 'DigitalOcean', description: 'DigitalOcean Droplets' },
    { name: 'hetzner', label: 'Hetzner', description: 'Hetzner Cloud servers' },
    { name: 'generic-vps', label: 'Generic VPS', description: 'Any Linux VPS with SSH access' },
    { name: 'local', label: 'Local', description: 'The current machine (Mac, dev laptop) via docker-compose' },
  ];
}

export default {
  providers,
  getProviderClass,
  createServer,
  listProviders
};
