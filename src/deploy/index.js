/**
 * Deployment module
 *
 * Main entry point for the deployment system.
 * Exports all deployment functionality.
 */

// Import everything first
import { RemoteServer, printStatus, printInfo, printWarning, printError } from './remote-server.js';
import { createServer, getProviderClass, listProviders } from './providers/index.js';
import {
  getDeployments,
  getEnabledDeployments,
  getDeployment,
  getDeploymentByProviderAndName,
  listDeployments,
  hasDeployments,
  getDefaultDeployment,
  getIpEnvVarName
} from './config.js';
import { commands, getCommandHelp } from './commands/index.js';

// Re-export everything
export {
  RemoteServer,
  printStatus,
  printInfo,
  printWarning,
  printError,
  createServer,
  getProviderClass,
  listProviders,
  getDeployments,
  getEnabledDeployments,
  getDeployment,
  getDeploymentByProviderAndName,
  listDeployments,
  hasDeployments,
  getDefaultDeployment,
  getIpEnvVarName,
  commands,
  getCommandHelp
};

export default {
  RemoteServer,
  createServer,
  getProviderClass,
  listProviders,
  getDeployments,
  getEnabledDeployments,
  getDeployment,
  listDeployments,
  hasDeployments,
  getDefaultDeployment,
  commands
};
