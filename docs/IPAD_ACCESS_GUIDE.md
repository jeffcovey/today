# iPad Access Guide

This guide explains how to access your development container from your iPad when traveling.

## Overview

Using Tailscale, you can securely access your home development container from anywhere in the world. Your connection is encrypted end-to-end and doesn't require exposing any ports to the internet.

## Prerequisites

1. **Mac Mini at home** running the development container
2. **Tailscale account** (free at tailscale.com)
3. **iPad** with internet connection

## Initial Setup (One Time)

### 1. Install Tailscale on Mac Mini

- Download from https://tailscale.com/download/mac
- Or install from Mac App Store
- Sign in with your Google/GitHub/Microsoft account
- Leave running in background

### 2. Set Up Container with Tailscale

```bash
# In your local VS Code terminal
cd /path/to/today

# Rebuild container with new Tailscale configuration
# VS Code: Cmd+Shift+P → "Dev Containers: Rebuild Container"
```

### 3. Authenticate Tailscale in Container

```bash
# After rebuild, in container terminal
bin/setup --tailscale

# Follow prompts to authenticate
# Note the Tailscale IP (e.g., 100.101.102.103)
```

### 4. Install Apps on iPad

- **Tailscale** - From App Store (free)
- **Termius** or **Prompt 3** - SSH client (optional)
- **Safari** - For VS Code web access

## Connecting from iPad

### Option 1: VS Code for Web (Recommended)

**Note: This method requires VS Code Desktop to be running on your Mac Mini.**

1. Open Tailscale app on iPad
2. Ensure you're connected (green status)
3. Open Safari
4. Go to: `https://vscode.dev`
5. Click the "Remote Explorer" icon in the sidebar (computer with arrow)
6. Click "Connect to Host" under SSH Targets
7. Enter: `node@100.x.x.x:2222` (your Tailscale IP)

**Alternative: Use the existing VS Code server**
If you have VS Code open on your Mac Mini, you can access it via:
`http://100.x.x.x:PORT` where PORT is the forwarded port from your VS Code tunnel.

### Option 2: SSH Client

1. Open Tailscale app on iPad
2. Open SSH client (Termius/Prompt)
3. Create new connection:
   - Host: `100.x.x.x` (your Tailscale IP)
   - Port: `2222`
   - User: `node`
   - Key: Copy from container's `/home/node/.ssh/id_rsa`

### Option 3: Code Server (Web IDE)

If you prefer a full web-based IDE:

```bash
# Code-server is already installed in the container

# Run code-server (specifying the workspace directory)
nohup code-server --bind-addr 0.0.0.0:8081 /workspaces/today > /tmp/code-server.log 2>&1 &

# Get the password from the config file
cat ~/.config/code-server/config.yaml

# Check that it's running
ps aux | grep code-server

# Access from iPad Safari at:
# http://100.x.x.x:8081 (your Tailscale IP)
# Enter the password when prompted
```

**Note:** You may need to rebuild the container for port 8081 to be properly forwarded. If the connection fails, try rebuilding the devcontainer.

## Finding Your Container's IP

### From Container

```bash
tailscale ip -4
```

### From Tailscale Admin

1. Go to https://login.tailscale.com/admin/machines
2. Find your container in the list
3. Copy the IP address

### Using MagicDNS

- Enable MagicDNS in Tailscale admin
- Access by hostname: `today-container.tail-scale.ts.net`

## Tips for iPad Development

### Keyboard Shortcuts

- External keyboard recommended
- Cmd+K opens VS Code command palette
- Esc key might need remapping in SSH clients

### File Management

- Use VS Code's file explorer
- Or install file manager in container

### Terminal Usage

- VS Code terminal works well
- Consider tmux for persistent sessions

### Battery & Connection

- Tailscale maintains connection through network changes
- Works on cellular and WiFi
- Minimal battery impact

## Troubleshooting

### Can't connect from iPad

1. Check Tailscale is running on both devices
2. Verify both logged into same account
3. Check container is running on Mac Mini
4. Try: `tailscale ping 100.x.x.x` from iPad

### Connection drops

- Tailscale auto-reconnects
- Check Mac Mini hasn't gone to sleep
- Ensure "Prevent Sleep" is enabled

### Slow performance

- Check internet connection quality
- Consider using mosh instead of SSH
- Reduce VS Code extensions

## Security Notes

- All traffic encrypted with WireGuard
- No ports exposed to internet
- Access controlled by Tailscale ACLs
- Can revoke device access anytime

## Keep Container Running

To ensure your container stays available:

### On Mac Mini

```bash
# Prevent Mac from sleeping
caffeinate -d

# Or use Energy Saver settings
# System Preferences → Energy Saver → Prevent computer from sleeping
```

### Container Auto-Start

```bash
# Add to Mac's login items
# Or use Docker Desktop's auto-start feature
```
