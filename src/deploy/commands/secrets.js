/**
 * Secrets command
 *
 * Upload encrypted secrets (.env files) to the server
 */

import { printStatus, printInfo, printWarning, printError } from '../remote-server.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');

export async function secretsCommand(server, args = []) {
  console.log(`🔐 Updating secrets on ${server.name}...`);

  if (!server.validate()) {
    process.exit(1);
  }

  const deployPath = server.deployPath;

  // Check for .env file
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    printError('.env file not found');
    console.log('Create one with: npx dotenvx set KEY value');
    process.exit(1);
  }

  // Upload .env
  printInfo('Copying .env file...');
  server.scpToRemote(envPath, `${deployPath}/.env`);

  // Upload .env.keys if it exists
  const envKeysPath = path.join(PROJECT_ROOT, '.env.keys');
  if (fs.existsSync(envKeysPath)) {
    printInfo('Copying decryption keys...');

    // Extract just the DOTENV_PRIVATE_KEY line
    const content = fs.readFileSync(envKeysPath, 'utf8');
    let privateKeyLine = null;

    for (const line of content.split('\n')) {
      if (line.startsWith('DOTENV_PRIVATE_KEY=')) {
        privateKeyLine = line.trim();
        break;
      }
    }

    if (privateKeyLine) {
      // Write to remote
      server.sshCmd(`echo '${privateKeyLine}' > ${deployPath}/.env.keys`);
    } else {
      printWarning('No DOTENV_PRIVATE_KEY found in .env.keys');
    }
  }

  // Set proper permissions
  printInfo('Setting permissions...');
  server.sshCmd(`chmod 600 ${deployPath}/.env*`);

  // Restart services to pick up new secrets
  printInfo('Restarting services...');
  server.systemctl('restart', 'today-scheduler', { check: false });
  server.systemctl('restart', 'vault-watcher', { check: false });

  printStatus('Secrets updated!');
}

export default secretsCommand;
