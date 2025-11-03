# Tailscale Setup for Remote Access

## Overview

Tailscale provides secure remote access to your development container from anywhere, including your iPad. It creates a private mesh network that works through NAT and firewalls without port forwarding.

## Architecture

```
iPad (Tailscale App) 
    ↓
[Internet/Tailscale Network]
    ↓
Mac Mini (Tailscale) 
    ↓
Docker Container (Tailscale + SSH/VS Code)
```

## Setup Components

### 1. Tailscale Account

- Sign up at https://tailscale.com
- Free tier supports up to 100 devices and 3 users
- Uses your existing Google, GitHub, or Microsoft account

### 2. Host Machine (Mac Mini)

- Install Tailscale from App Store or https://tailscale.com/download
- Authenticate and join your tailnet
- Note the Tailscale IP (100.x.x.x)

### 3. DevContainer Integration

- Tailscale runs inside the container
- Shares network namespace with host (safer) OR runs independently
- SSH server accessible via Tailscale IP

### 4. iPad Access

- Install Tailscale from App Store
- Use VS Code for Web (vscode.dev) or SSH client app
- Connect using container's Tailscale IP

## Implementation Plan

1. **Add Tailscale feature to devcontainer.json**
   - Use official Tailscale devcontainer feature
   - Configure authentication method

2. **Create setup script (bin/setup --tailscale)**
   - Check Tailscale status
   - Guide through authentication
   - Display connection info

3. **Update SSH configuration**
   - Ensure SSH listens on Tailscale interface
   - Configure for remote access

4. **Documentation**
   - Connection instructions
   - Security considerations
   - Troubleshooting guide

## Security Considerations

- **Authentication**: Tailscale uses OAuth providers (Google, GitHub, Microsoft)
- **Encryption**: All traffic is end-to-end encrypted using WireGuard
- **Access Control**: Can set ACLs in Tailscale admin console
- **No exposed ports**: No public internet exposure

### Default Passwords

The container is configured with default passwords for convenience:
- **SSH Password**: `ipad2025`
- **VS Code Server Password**: `ipad2025`

⚠️ **Security Note**: These passwords are only accessible over the Tailscale network (encrypted WireGuard tunnel), not the public internet. However, you should change them if:
- You share your Tailscale network with others
- You want additional security

To change passwords:
```bash
# Change SSH password
export SSH_PASSWORD="your-secure-password"
bin/setup --ssh

# Change code-server password
export CODE_SERVER_PASSWORD="your-secure-password"
bin/start-code-server
```

## Benefits

- ✅ **Zero configuration networking** - Works through NAT/firewalls
- ✅ **Secure by default** - WireGuard encryption
- ✅ **Cross-platform** - Works on all your devices
- ✅ **Stable IPs** - Each device gets a consistent IP
- ✅ **MagicDNS** - Access devices by name

## Quick Start

### 1. First Time Setup

```bash
# Option A: Set auth key before rebuilding container
export TAILSCALE_AUTHKEY="tskey-auth-xxxx"

# Option B: Interactive authentication after rebuild
bin/setup --tailscale
```

### 2. Get Connection Info

```bash
# Check Tailscale status
tailscale status

# Get your Tailscale IP
tailscale ip -4
```

### 3. Connect from iPad

#### SSH Access (Terminal)

1. Install Tailscale app on iPad
2. Sign in with same Tailscale account
3. Install an SSH client (Blink, Termius, etc.)
4. Connect using:
   ```
   ssh node@[tailscale-ip] -p 2222
   ```
5. **Password**: `ipad2025` (default, can be changed via `SSH_PASSWORD` env var)

#### VS Code Server Access (Browser-based IDE)

1. Start code-server in the container:
   ```bash
   bin/start-code-server
   ```
2. Open in iPad browser: `http://[tailscale-ip]:8081`
3. **Password**: `ipad2025` (default, can be changed via `CODE_SERVER_PASSWORD` env var)

Note: code-server is not started automatically on container startup - run it manually when needed.

## Troubleshooting

### Tailscale not starting

- Ensure you've authenticated (run `bin/setup --tailscale`)
- Check status: `tailscale status`
- View logs: `tailscale bugreport`

### Can't connect via SSH

- Verify SSH is running: `service ssh status`
- Check Tailscale IP: `tailscale ip -4`
- Ensure both devices are on same Tailnet
- Default password is `ipad2025`
- If using Blink on iPad, use `-p 2222` flag (not colon syntax)

### Can't connect to VS Code Server

- Ensure code-server is running: `ps aux | grep code-server`
- Start it manually: `bin/start-code-server`
- Check logs: `cat ~/.config/code-server/code-server.log`
- Default password is `ipad2025`
- Access at: `http://[tailscale-ip]:8081`

### Auth key setup

1. Go to: https://login.tailscale.com/admin/settings/keys
2. Create new auth key
3. Add to `.env` file: `TAILSCALE_AUTHKEY=tskey-auth-xxxx`
4. Rebuild container
