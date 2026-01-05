/**
 * Maintenance command
 *
 * Run maintenance tasks on the server (cleanup logs, check disk, etc.)
 */

import { printStatus, printInfo, printWarning, printError } from '../remote-server.js';

export async function maintenanceCommand(server, args = []) {
  console.log(`🧹 Running maintenance on ${server.name}...`);

  if (!server.validate()) {
    process.exit(1);
  }

  const deployPath = server.deployPath;

  // The maintenance script with templated paths
  const maintenanceScript = `
set -e

# Colors
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
RED='\\033[0;31m'
NC='\\033[0m'

print_status() { echo -e "\${GREEN}✓\${NC} $1"; }
print_warning() { echo -e "\${YELLOW}⚠\${NC} $1"; }
print_error() { echo -e "\${RED}✗\${NC} $1"; }

# Configuration
MAX_LOG_SIZE_MB=100
DISK_WARNING_PERCENT=85

echo "🧹 Running maintenance..."

# 1. Check and kill stuck processes
print_status "Checking for stuck processes..."
STUCK_PROCESSES=$(ps aux | grep -E 'node.*bin/today.*--non-interactive' | grep -v grep | awk '{print $2}' || true)
if [ -n "$STUCK_PROCESSES" ]; then
    print_warning "Found stuck bin/today processes, killing..."
    echo "$STUCK_PROCESSES" | xargs -r kill -9
    print_status "Killed stuck processes"
else
    print_status "No stuck processes found"
fi

# 2. Clean up large log files
print_status "Checking log files..."

# System logs
if [ -f /var/log/syslog ]; then
    SYSLOG_SIZE=$(du -m /var/log/syslog | cut -f1)
    if [ "$SYSLOG_SIZE" -gt 500 ]; then
        print_warning "Syslog is \${SYSLOG_SIZE}MB, truncating..."
        sudo truncate -s 0 /var/log/syslog
        print_status "Truncated syslog"
    fi
fi

# Remove old rotated logs
sudo rm -f /var/log/syslog.*.gz /var/log/syslog.1 2>/dev/null || true

# Application logs
for LOG_FILE in ${deployPath}/.data/*.log; do
    if [ -f "$LOG_FILE" ]; then
        LOG_SIZE=$(du -m "$LOG_FILE" | cut -f1)
        if [ "$LOG_SIZE" -gt "$MAX_LOG_SIZE_MB" ]; then
            LOG_NAME=$(basename "$LOG_FILE")
            print_warning "$LOG_NAME is \${LOG_SIZE}MB, truncating..."
            truncate -s "\${MAX_LOG_SIZE_MB}M" "$LOG_FILE"
            print_status "Truncated $LOG_NAME"
        fi
    fi
done

# 3. Database maintenance
print_status "Checking database..."
if [ -f ${deployPath}/.data/today.db ]; then
    WAL_SIZE=$(du -m ${deployPath}/.data/today.db-wal 2>/dev/null | cut -f1 || echo 0)
    if [ "$WAL_SIZE" -gt 100 ]; then
        print_warning "WAL file is \${WAL_SIZE}MB, checkpointing..."
        sqlite3 ${deployPath}/.data/today.db 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true
        print_status "Database WAL checkpointed"
    fi

    # Vacuum database weekly (on Sundays)
    if [ "$(date +%w)" -eq "0" ]; then
        print_status "Running weekly database vacuum..."
        sqlite3 ${deployPath}/.data/today.db 'VACUUM;' 2>/dev/null || true
        print_status "Database vacuumed"
    fi
fi

# 4. Clean up journal logs
print_status "Cleaning journal logs..."
sudo journalctl --vacuum-time=7d --vacuum-size=500M 2>/dev/null || true

# 5. Clean npm cache if disk is tight
DISK_USAGE=$(df / | tail -1 | awk '{print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -gt 90 ]; then
    print_warning "Disk usage high (\${DISK_USAGE}%), cleaning npm cache..."
    npm cache clean --force 2>/dev/null || true
fi

# 6. Check disk space
if [ "$DISK_USAGE" -gt "$DISK_WARNING_PERCENT" ]; then
    print_error "Disk usage is \${DISK_USAGE}% - needs attention!"
else
    print_status "Disk usage is \${DISK_USAGE}%"
fi

# 7. Check system load
LOAD_1MIN=$(uptime | awk -F'load average:' '{print $2}' | awk '{print $1}' | sed 's/,//')
print_status "System load is $LOAD_1MIN"

# 8. Report status
echo ""
echo "📊 System Status:"
echo "  Disk: \${DISK_USAGE}% used"
echo "  Load: $LOAD_1MIN"
echo "  Memory: $(free -m | awk '/^Mem:/{printf "%.0f%% used", $3/$2 * 100}')"
echo ""
print_status "Maintenance complete!"
`;

  server.sshScript(maintenanceScript);
}

export default maintenanceCommand;
