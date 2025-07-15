# DevContainer Remote Access Setup

This document describes the automated setup for accessing your development containers remotely via iPad or other devices.

## What's Automated

When you start a devcontainer with this configuration:

1. **Code-server** is automatically installed during container creation
2. **Code-server** starts automatically when the container starts
3. **Access information** is displayed and saved for easy reference
4. **Tailscale** provides secure remote access
5. **Project-based naming** helps identify multiple containers

## Quick Start

### 1. Start Your DevContainer

Open your project in VS Code and start the devcontainer as usual.

### 2. Get Access Information

The access URLs are displayed automatically on startup. To view them again:

```bash
cat ~/.config/devcontainer/access-info.txt
```

### 3. Access from iPad

Open Safari and navigate to the URL shown (e.g., `http://100.65.74.31:8081`)

## Configuration Details

### Automatic Startup

The devcontainer.json includes:
- `postCreateCommand`: Installs dependencies and code-server
- `postStartCommand`: Runs the startup script
- `containerEnv`: Sets up environment variables for naming

### Scripts

Located in `/workspaces/notion-cli/bin/`:

- **devcontainer-startup**: Main orchestrator script
- **start-code-server**: Manages code-server process
- **setup-tailscale-hostname**: Configures meaningful hostnames
- **setup-ssh**: Configures SSH access

### Service Naming

Containers are named using the pattern: `{project}-{host}`
- Example: `notion-cli-macmini`
- Helps identify containers when running multiple projects

## Managing Multiple Projects

Each project container:
- Runs on port 8081 by default (changed from 8080 to avoid VS Code conflicts)
- Has a unique Tailscale IP
- Can be identified by project name

To run multiple projects simultaneously, modify the port in the project's devcontainer.json.

## Troubleshooting

### Code-server Won't Start
```bash
# Check the logs
cat ~/.config/code-server/code-server.log

# Restart manually
bin/start-code-server
```

### Can't Connect from iPad
1. Verify Tailscale is connected on both devices
2. Check the container is running
3. Confirm the IP address: `tailscale ip -4`

### Performance Issues
- Ensure good internet connection
- Consider reducing VS Code extensions
- Check that unnecessary services aren't running

## Security Considerations

Current setup uses no authentication for simplicity within your Tailscale network. To add authentication:

```bash
# Edit the config
nano ~/.config/code-server/config.yaml

# Change auth from "none" to "password"
# Set a strong password
```

## Future Enhancements

Potential improvements to consider:
1. HTTPS with self-signed certificates
2. Integration with Tailscale MagicDNS for memorable URLs
3. Automatic port assignment for multiple containers
4. Health monitoring and auto-restart capabilities