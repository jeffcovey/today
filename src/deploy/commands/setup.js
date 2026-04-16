/**
 * Setup command
 *
 * Initial server setup - installs dependencies, configures services
 */

import { printStatus, printInfo, printError } from '../remote-server.js';

export async function setupCommand(server, args = []) {
  console.log(`🚀 Setting up ${server.name} (${server.provider})...`);

  if (!server.validate()) {
    process.exit(1);
  }

  // Check for options
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const withOllama = args.includes('--ollama');
  const withResilio = args.includes('--resilio');
  const withGitSync = args.includes('--git-sync');
  const withUnison = args.includes('--unison');

  if (withResilio && withGitSync) {
    printError('--resilio and --git-sync are mutually exclusive; pick one vault sync method.');
    process.exit(1);
  }

  if (!skipConfirm && process.stdin.isTTY) {
    console.log('');
    console.log('This will:');
    console.log('  • Update system packages');
    console.log('  • Install Node.js 20.x');
    console.log('  • Install nginx, sqlite3, and other dependencies');
    console.log('  • Create deployment directories');
    console.log('  • Configure firewall');
    if (withOllama) {
      console.log('  • Install Ollama for local LLMs');
    }
    if (withResilio) {
      console.log('  • Install Resilio Sync for vault synchronization');
    }
    if (withGitSync) {
      console.log('  • Install git-sync for vault synchronization via GitHub');
    }
    if (withUnison) {
      console.log('  • Install Unison for bidirectional file sync');
    }
    console.log('');

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question('Continue? [Y/n] ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // Run provider-specific setup
  if (typeof server.setup === 'function') {
    await server.setup();
  } else {
    printError('Provider does not support setup command');
    process.exit(1);
  }

  // Setup SSL if domain is configured
  if (server.domain && typeof server.setupSsl === 'function') {
    await server.setupSsl();
  }

  // Optional: Resilio Sync. Providers that don't support it (e.g. local)
  // should define a setupResilioSync() that prints a clear warning.
  if (withResilio && typeof server.setupResilioSync === 'function') {
    await server.setupResilioSync();
  }

  // Optional: git-sync. On remote providers this installs the systemd
  // timer; on local providers it prints guidance on adding the job to
  // config.toml (see LocalProvider.setupGitSync).
  if (withGitSync && typeof server.setupGitSync === 'function') {
    await server.setupGitSync();
  }

  // Optional: Unison. On remote providers this installs the unison binary
  // so the server can be a sync target. On local providers it prints
  // guidance (the compose service handles the local end).
  if (withUnison && typeof server.setupUnison === 'function') {
    await server.setupUnison();
  }

  // Optional: Ollama
  if (withOllama && typeof server.setupOllama === 'function') {
    await server.setupOllama();
  }

  printStatus('Setup complete!');
  console.log('');
  console.log('Next steps:');
  console.log(`  1. bin/deploy ${server.name} secrets    # Upload encrypted secrets`);
  console.log(`  2. bin/deploy ${server.name}            # Deploy code`);
  if (!withResilio && !withGitSync) {
    console.log('  3. Pick a vault sync method:');
    console.log(`       bin/deploy ${server.name} setup --git-sync   # Sync via GitHub (recommended)`);
    console.log(`       bin/deploy ${server.name} setup --resilio    # Sync via Resilio Sync`);
  }
}

export default setupCommand;
