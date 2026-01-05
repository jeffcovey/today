/**
 * Exec command
 *
 * Execute a command on the remote server
 */

import { printError } from '../remote-server.js';

export async function execCommand(server, args = []) {
  if (!server.validate()) {
    process.exit(1);
  }

  if (args.length === 0) {
    printError('Usage: bin/deploy <name> exec <command>');
    console.log('');
    console.log('Examples:');
    console.log('  bin/deploy production exec "df -h"');
    console.log('  bin/deploy production exec "npm test"');
    console.log('  bin/deploy production exec "sqlite3 .data/today.db \'.tables\'"');
    process.exit(1);
  }

  const command = args.join(' ');
  server.exec(command);
}

export default execCommand;
