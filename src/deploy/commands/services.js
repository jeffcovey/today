/**
 * Services command
 *
 * Manage systemd services on the server
 */

import { printStatus, printInfo, printWarning, printError } from '../remote-server.js';

const SERVICES = [
  'today-scheduler',
  'vault-watcher',
  'vault-web',
  'inbox-api',
  'resilio-sync'
];

export async function servicesCommand(server, args = []) {
  if (!server.validate()) {
    process.exit(1);
  }

  const action = args[0];
  const service = args[1];

  if (!action || action === 'status' || action === 'list') {
    // Show status of all services
    console.log(`📋 Services on ${server.name}:`);
    console.log('');

    server.sshScript(`
for service in ${SERVICES.join(' ')}; do
    if systemctl is-active --quiet $service 2>/dev/null; then
        echo "  ✓ $service (running)"
    elif systemctl is-enabled --quiet $service 2>/dev/null; then
        echo "  ○ $service (stopped)"
    else
        echo "  - $service (not installed)"
    fi
done
`);
    return;
  }

  // Validate action
  const validActions = ['start', 'stop', 'restart', 'enable', 'disable', 'logs'];
  if (!validActions.includes(action)) {
    printError(`Unknown action: ${action}`);
    console.log('');
    console.log('Usage: bin/deploy <name> services [action] [service]');
    console.log('');
    console.log('Actions:');
    console.log('  status   Show status of all services (default)');
    console.log('  start    Start a service');
    console.log('  stop     Stop a service');
    console.log('  restart  Restart a service');
    console.log('  enable   Enable a service to start on boot');
    console.log('  disable  Disable a service from starting on boot');
    console.log('  logs     View service logs');
    console.log('');
    console.log('Services:', SERVICES.join(', '));
    process.exit(1);
  }

  // Handle 'all' services
  if (service === 'all') {
    if (action === 'restart') {
      printInfo('Restarting all services...');
      for (const svc of SERVICES) {
        server.systemctl('restart', svc, { check: false });
      }
      printStatus('All services restarted');
    } else {
      printError(`Cannot use 'all' with action: ${action}`);
    }
    return;
  }

  // Validate service name
  if (!service) {
    printError('Service name required');
    console.log('');
    console.log('Available services:', SERVICES.join(', '));
    console.log('Or use "all" to restart all services');
    process.exit(1);
  }

  // Handle logs specially
  if (action === 'logs') {
    server.viewLogs(service, { follow: args.includes('-f'), lines: 100 });
    return;
  }

  // Execute the action
  printInfo(`${action} ${service}...`);
  server.systemctl(action, service);
  printStatus(`${service} ${action}ed`);
}

export default servicesCommand;
