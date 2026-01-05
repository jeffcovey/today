/**
 * Logs command
 *
 * View service logs from the server
 */

import { printInfo, printError } from '../remote-server.js';

const KNOWN_SERVICES = [
  'today-scheduler',
  'vault-watcher',
  'vault-web',
  'vault-api',
  'inbox-api',
  'resilio-sync',
  'nginx',
  'ollama'
];

export async function logsCommand(server, args = []) {
  if (!server.validate()) {
    process.exit(1);
  }

  // Parse arguments
  let service = 'today-scheduler';  // default
  let follow = false;
  let lines = 100;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-f' || arg === '--follow') {
      follow = true;
    } else if (arg === '-n' || arg === '--lines') {
      lines = parseInt(args[++i], 10) || 100;
    } else if (!arg.startsWith('-')) {
      service = arg;
    }
  }

  console.log(`📊 Logs for ${service} on ${server.name}...`);

  // Show available services if requested
  if (service === 'list' || service === '--list') {
    printInfo('Known services:');
    for (const s of KNOWN_SERVICES) {
      console.log(`  • ${s}`);
    }
    console.log('');
    console.log('Usage: bin/deploy <name> logs [service] [-f] [-n lines]');
    return;
  }

  server.viewLogs(service, { follow, lines });
}

export default logsCommand;
