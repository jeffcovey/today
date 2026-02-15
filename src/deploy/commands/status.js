/**
 * Status command
 *
 * Show server and service status
 */

import { printStatus, printInfo, printWarning, printError } from '../remote-server.js';

export async function statusCommand(server, args = []) {
  console.log(`📈 Status for ${server.name} (${server.provider})...`);

  if (!server.validate()) {
    process.exit(1);
  }

  const deployPath = server.deployPath;

  // Check connection
  printInfo('Testing connection...');
  const connected = await server.testConnection();
  if (!connected) {
    printError('Cannot connect to server');
    process.exit(1);
  }
  printStatus('Connected');

  // Show server info
  console.log('');
  console.log('Server Information:');
  console.log(`  IP: ${server.ip}`);
  if (server.domain) {
    console.log(`  Domain: ${server.domain}`);
  }
  console.log(`  Deploy Path: ${deployPath}`);
  console.log(`  User: ${server.sshUser}`);
  console.log('');

  // Check disk space and system info
  server.sshScript(`
echo "System Status:"
echo "  OS: $(cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '"')"
echo "  Uptime: $(uptime -p)"
echo "  Load: $(uptime | awk -F'load average:' '{print $2}')"
echo "  Memory: $(free -m | awk '/^Mem:/{printf "%dMB / %dMB (%.0f%%)", $3, $2, $3/$2 * 100}')"
echo "  Disk: $(df -h / | tail -1 | awk '{printf "%s / %s (%s)", $3, $2, $5}')"
echo ""

echo "Services:"
for service in today-scheduler vault-web inbox-api resilio-sync nginx; do
    if systemctl is-active --quiet $service 2>/dev/null; then
        echo "  ✓ $service (running)"
    elif systemctl is-enabled --quiet $service 2>/dev/null; then
        echo "  ○ $service (stopped)"
    else
        echo "  - $service (not installed)"
    fi
done
echo ""

if [ -f ${deployPath}/.data/today.db ]; then
    echo "Database:"
    DB_SIZE=$(du -h ${deployPath}/.data/today.db | cut -f1)
    TASK_COUNT=$(sqlite3 ${deployPath}/.data/today.db 'SELECT COUNT(*) FROM tasks' 2>/dev/null || echo "?")
    echo "  Size: $DB_SIZE"
    echo "  Tasks: $TASK_COUNT"
    echo ""
fi

if [ -d ${deployPath}/${server.remoteVaultPath} ]; then
    echo "Vault:"
    VAULT_SIZE=$(du -sh ${deployPath}/${server.remoteVaultPath} | cut -f1)
    FILE_COUNT=$(find ${deployPath}/${server.remoteVaultPath} -type f | wc -l)
    echo "  Size: $VAULT_SIZE"
    echo "  Files: $FILE_COUNT"
fi
`);
}

export default statusCommand;
