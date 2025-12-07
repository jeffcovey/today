# Resilio Sync Setup Documentation

## Overview

This document describes the migration from git-based vault synchronization to Resilio Sync for the Today app.

## Background

- **Previous Issue**: Git-based sync was causing timeouts with 4.7GB of vault files (3,887 files)
- **Failed Alternatives**: Syncthing was removed due to causing problems
- **Solution**: Resilio Sync - a P2P file synchronization tool that handles large files efficiently

## Requirements

- Single service for all file types
- No dependency on Obsidian
- Automatic conflict resolution
- Support for multiple deployments

## Installation Steps

### 1. Droplet Setup (Completed)

- Added to `/opt/today/bin/setup-droplet.sh` for automatic installation
- Added to deployment process in `bin/deploy-do` to ensure it's installed on every deployment
- Service available at:
  - **HTTPS**: https://sync.your-domain.example.com (requires DNS setup)
  - **HTTP**: http://YOUR_DROPLET_IP:8889 (direct access)

#### DNS Setup Required

1. Add an A record for `sync.your-domain.example.com` → `YOUR_DROPLET_IP`
2. Once DNS propagates, SSL certificate will be automatically configured
3. If SSL setup fails initially, run:

   ```bash
   bin/deploy-do exec "sudo certbot --nginx -d sync.your-domain.example.com --non-interactive --agree-tos --email admin@example.com --redirect"
   ```

### 2. Local Setup (Completed)

Resilio Sync runs on the host macOS system, not in the container.

#### Host Configuration

- Resilio Sync installed and running on macOS
- Vault synced via iCloud at: `~/Library/Mobile Documents/com~apple~CloudDocs/vault`
- Vault mounted into container at: `/workspaces/today/vault`

#### Container Configuration

- No Resilio Sync installation needed in container
- Container uses mounted vault from host
- All changes in container automatically sync via host's Resilio Sync

### 3. Configuration

- Vault directory: `/workspaces/today/vault` (local) and `/opt/today/vault` (droplet)
- Web UI ports: 8888 (local), 8889 (droplet)
- User: rslsync (system user with full write permissions to vault)
- Password: Automatically generated on first setup (stored in `/opt/today/.resilio-password`)

### 4. Security & Password Management

- **Password**: The password is "admin" by default (stored in `/etc/resilio-sync/config.json`)
- **Persistence**: Configuration and passwords persist across deployments
- **Changing Password**:
  1. Through Web UI: Settings → Preferences → Authorization
  2. Or edit `/etc/resilio-sync/config.json` and restart service
- **Secure Access**: Use SSH tunnel for encrypted access:

  ```bash
  ssh -L 8889:localhost:8889 root@YOUR_DROPLET_IP
  # Then open: http://localhost:8889
  ```

### 5. Adding Sync Folders

When adding folders through the Web UI:
1. The `/opt/today/vault` folder should already have correct permissions
2. If you get permission errors, run: `bin/deploy-do resilio-sync fix-permissions`
3. .btskey files and sync settings are stored in `/var/lib/resilio-sync/` and persist across deployments

## Migration Process

### Phase 1: Stop Git Sync (Completed)

- [x] Stopped vault-auto-sync cron job locally
- [x] Stopped vault-auto-sync on droplet
- [x] Backed up local vault to droplet using rsync

### Phase 2: Install Resilio Sync (Completed)

- [x] Added to droplet setup script
- [x] Installed on droplet
- [x] Install locally (on macOS host)
- [x] Configure sync folders
- [x] Test synchronization

### Phase 3: Clean Up Git (Completed)

- [x] Remove vault/.git directory
- [x] Remove git sync code from bin/vault-sync
- [x] Remove vault from GitHub repository
- [x] Remove Resilio Sync from container configuration

## Commands Reference

### Check Resilio Sync Status

```bash
# On droplet
sudo systemctl status resilio-sync

# Check if installed
command -v rslsync
```

### Access Web UI

- Local: Resilio Sync app on macOS
- Droplet: http://YOUR_DROPLET_IP:8889

### Manual Installation (if needed)

```bash
bin/deploy-do resilio-sync setup  # On droplet
```

## Troubleshooting

### If sync isn't working

1. Check service status: `sudo systemctl status resilio-sync`
2. Check logs: `sudo journalctl -u resilio-sync -f`
3. Verify folders have correct permissions
4. Check firewall rules for port 8889

### Common Issues

#### PID file error

If you see "Can't open pid file /var/run/resilio-sync/sync.pid":
- Fixed automatically in `bin/deploy-do resilio-sync setup`
- The systemd service now creates the directory on each start

#### If installation fails

- The deployment script automatically detects and installs Resilio Sync
- Manual installation available via: `bin/deploy-do resilio-sync setup`
- The setup script now properly creates all required directories

## Benefits Over Git

- No file size limitations
- Real-time synchronization
- Better handling of binary files
- No commit/push workflow needed
- Automatic conflict resolution with versioning
