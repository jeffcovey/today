# Syncthing Setup for Vault Files

## Overview

The `vault/` directory (119 files, ~8MB) is now configured to sync via Syncthing instead of Git, eliminating commit clutter and enabling real-time synchronization.

## Container Support

Syncthing is pre-installed in both container environments:
- **Production Dockerfile**: Alpine-based with `apk add syncthing`
- **Dev Container**: Debian-based with `apt-get install syncthing`

## Setup Instructions

### Container Port Access (macOS/Docker)

When running in a devcontainer on macOS, Syncthing runs inside the container:
- **Container Syncthing**: Accessible at `http://localhost:8384` after port forwarding
- **macOS Syncthing**: Your existing Syncthing instance (if any) is separate
- These are **two different Syncthing instances** that can sync with each other
- Port 8384 is forwarded in `.devcontainer/devcontainer.json`

### 1. Add Folder in Syncthing Web UI

1. Open Syncthing web interface (usually http://localhost:8384)
2. Click "Add Folder"
3. Configure:
   - **Folder Label**: `Today Vault`
   - **Folder Path**:
     - Container: `/workspaces/today/vault`
     - macOS: `~/Sync/vault` (NOT the entire ~/Sync directory)
   - **Folder ID**: `today-vault` (must match on both sides)
   - **File Versioning**: Simple (recommended) or Trash Can
   - **Ignore Patterns**: Already configured in `vault/.stignore`

### 2. Sharing Settings

- Share with your other devices
- Enable "Send Only" if this is the primary source
- Enable "Receive Only" on read-only devices
- Use "Send & Receive" for bidirectional sync

### 3. Advanced Settings (Optional)

- **Rescan Interval**: 60s (or lower for faster sync)
- **File Pull Order**: Alphabetic or Newest First
- **Ignore Permissions**: Enable if syncing between different OS types

## File Structure

```
vault/
├── .stignore       # Syncthing ignore patterns
├── logs/           # Log files
├── notes/          # Personal notes
├── plans/          # Planning documents  
├── projects/       # Project documentation
├── templates/      # Document templates
└── topics/         # Topic-specific notes
```

## Benefits

- **No Git commits** for simple file edits
- **Real-time sync** across devices
- **Conflict resolution** built-in
- **Version history** without cluttering git
- **Faster edits** - no commit/push/pull cycle

## Migration Notes

- Existing vault files remain in place
- Git now ignores the entire `vault/` directory
- The `.stignore` file is preserved in git for configuration sharing
- All future vault changes sync via Syncthing only

### Git and Syncthing Coexistence

**You can safely run both Git and Syncthing during migration:**
- Git is configured to ignore `vault/` via `.gitignore`
- Syncthing syncs files in real-time
- No conflicts between the two systems
- Recommended migration approach:
  1. Set up Syncthing first (test for a few days)
  2. Keep Git sync enabled as backup
  3. Once confident, vault changes automatically excluded from Git
  4. No need to disable Git - it simply ignores vault files

### Managing Existing ~/Sync Directory

If you already use Syncthing with a large `~/Sync` directory:
- **DO NOT** share your entire `~/Sync` folder
- Create a **new folder share** specifically for `~/Sync/vault`
- Use a unique Folder ID like `today-vault`
- This keeps vault sync completely separate from other Syncthing folders
- Your existing Syncthing folders remain unchanged

## Conflict Resolution

Syncthing creates conflict files with timestamps when simultaneous edits occur:
- `file.md.sync-conflict-20250825-143022-DEVICEID.md`
- Review and merge manually when conflicts arise

## Monitoring

- Check sync status in Syncthing web UI
- View recent changes in "Recent Changes" panel
- Monitor folder status for out-of-sync files

## Headless Setup (SSH/Terminal Only)

For headless environments, use the included `bin/syncthing-headless` script:

### Quick Setup

```bash
# Complete headless setup (generates config, starts daemon, adds vault)
bin/syncthing-headless setup

# This will:
# 1. Generate Syncthing config if needed
# 2. Start Syncthing in background
# 3. Disable GUI authentication for headless access
# 4. Add the vault folder automatically
# 5. Display your device ID for pairing
```

### Manual Commands

```bash
# Start Syncthing daemon
bin/syncthing-headless start

# Stop Syncthing
bin/syncthing-headless stop

# Check status and get device ID
bin/syncthing-headless status

# Add vault folder to existing instance
bin/syncthing-headless add-vault

# Get device ID for pairing
bin/syncthing-headless device-id
```

### Headless Access Options

1. **Port Forwarding (SSH)**

   ```bash
   # Forward Syncthing web UI to your local machine
   ssh -L 8384:localhost:8384 user@server
   # Then access http://localhost:8384 locally
   ```

2. **Direct Access (if network allows)**
   - Access `http://server-ip:8384` directly
   - Note: GUI auth is disabled in headless setup for easier access

3. **API Access**
   - The script uses Syncthing's REST API
   - API key is extracted from config automatically

### Environment Variables

- `SYNCTHING_PORT`: Custom port (default: 8384)
- `VAULT_PATH`: Custom vault path (default: /workspaces/today/vault)
