/**
 * Command registry
 *
 * Maps command names to their implementations
 */

import { deployCommand } from './deploy.js';
import { setupCommand } from './setup.js';
import { sshCommand } from './ssh.js';
import { logsCommand } from './logs.js';
import { execCommand } from './exec.js';
import { maintenanceCommand } from './maintenance.js';
import { statusCommand } from './status.js';
import { secretsCommand } from './secrets.js';
import { servicesCommand } from './services.js';

export const commands = {
  'deploy': deployCommand,
  'setup': setupCommand,
  'ssh': sshCommand,
  'logs': logsCommand,
  'exec': execCommand,
  'maintenance': maintenanceCommand,
  'status': statusCommand,
  'secrets': secretsCommand,
  'services': servicesCommand,
  // Aliases
  'shell': sshCommand,
  'run': execCommand,
  'maint': maintenanceCommand,
};

/**
 * Get command help text
 */
export function getCommandHelp() {
  return `
Commands:
  deploy      Deploy code to the server (default)
  setup       Initial server setup (run once)
  ssh         Open interactive SSH session
  logs        View service logs
  exec        Execute a command on the server
  status      Show server and service status
  secrets     Update encrypted secrets (.env)
  services    Manage systemd services
  maintenance Run maintenance tasks

Aliases:
  shell       Alias for ssh
  run         Alias for exec
  maint       Alias for maintenance
`;
}

export default commands;
