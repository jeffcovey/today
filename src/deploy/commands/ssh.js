/**
 * SSH command
 *
 * Open interactive SSH session to the server
 */

import { printInfo } from '../remote-server.js';

export async function sshCommand(server, args = []) {
  console.log(`🔌 Connecting to ${server.name}...`);

  if (!server.validate()) {
    process.exit(1);
  }

  printInfo(`SSH to ${server.sshUser}@${server.ip}:${server.sshPort}`);

  const exitCode = server.sshInteractive();
  process.exit(exitCode);
}

export default sshCommand;
