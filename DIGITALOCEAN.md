# DigitalOcean Deployment Guide

Deploy your Today app to a DigitalOcean droplet for always-on scheduling and full SSH access with interactive Claude.

## Prerequisites

1. **DigitalOcean Account**: Sign up at [digitalocean.com](https://www.digitalocean.com/)
2. **SSH Key**: Add your SSH public key to DigitalOcean

## Create a Droplet

1. Go to [DigitalOcean Control Panel](https://cloud.digitalocean.com/droplets)
2. Click "Create Droplet"
3. Choose:
   - **Image**: Ubuntu 24.04 LTS
   - **Size**: Basic → Regular → $6/month (1 GB RAM, 25 GB SSD)
   - **Region**: Choose closest to you
   - **Authentication**: Select your SSH key
   - **Hostname**: `today-scheduler` (or your preference)

4. Click "Create Droplet" and wait for it to provision
5. Note your droplet's IP address

## Initial Setup

```bash
# Set your droplet IP
export DO_DROPLET_IP=your.droplet.ip.address

# Or add to .env for persistence
echo "DO_DROPLET_IP=your.droplet.ip.address" >> .env

# Run initial setup (installs Node.js, Claude CLI, etc.)
bin/deploy-do setup

# Copy your secrets
bin/deploy-do secrets

# Deploy your code
bin/deploy-do deploy
```

## Daily Operations

### Check Status
```bash
bin/deploy-do status
```

### View Logs
```bash
bin/deploy-do logs
```

### SSH Access
```bash
bin/deploy-do ssh
# Once connected, you can use:
cd /opt/today
bin/today "Work on my projects"  # Interactive Claude works!
```

### Deploy Updates
```bash
# After making code changes
bin/deploy-do deploy
```

### Restart Scheduler
```bash
bin/deploy-do restart
```

## Schedule

The scheduler runs automatically via systemd with these tasks:
- **Every 10 minutes**: `bin/sync --quick` - Quick sync of GitHub vault and tasks
- **Every 2 hours (5AM-9PM)**: `bin/today "Update today's review file"` - Claude updates your daily review
- **Daily at 3AM**: `bin/notion daily --all` (temporary until migration)

Edit `src/scheduler.js` to customize the schedule.

## Monitoring

### Check scheduler logs
```bash
bin/deploy-do logs
# Or directly on the droplet:
journalctl -u today-scheduler -f
```

### Check system resources
```bash
bin/deploy-do exec "free -h"
bin/deploy-do exec "df -h"
bin/deploy-do exec "top -bn1 | head -20"
```

## Troubleshooting

### Scheduler not running?
```bash
bin/deploy-do status
bin/deploy-do start
```

### Need to debug?
```bash
bin/deploy-do ssh
cd /opt/today
# Check logs
journalctl -u today-scheduler --since "1 hour ago"
# Test commands manually
bin/sync --quick
bin/today "Test Claude"
```

### Update Node.js or dependencies?
```bash
bin/deploy-do ssh
# Update Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
# Update Claude CLI
npm install -g @anthropic-ai/claude-code@latest
```

## Cost

- **Droplet**: $6/month for Basic droplet (1GB RAM, 25GB SSD, 1TB transfer)
- **Backups**: +$1.20/month (optional but recommended)
- **Total**: ~$7.20/month with backups

## Security Notes

1. **SSH Key Only**: Password authentication is disabled by default
2. **Firewall**: Consider enabling UFW firewall:
   ```bash
   bin/deploy-do exec "ufw allow 22 && ufw --force enable"
   ```
3. **Keep Secrets Secure**: Never commit `.env` or `.env.keys` files
4. **Regular Updates**: Keep system updated:
   ```bash
   bin/deploy-do exec "apt update && apt upgrade -y"
   ```

## Advantages over Fly.io

✅ **Full SSH access** - Interactive Claude works perfectly
✅ **Standard Linux** - Everything works as expected  
✅ **Simple deployment** - Just rsync and systemd
✅ **Better debugging** - Full access to logs and system
✅ **No container overhead** - Direct Node.js execution
✅ **Persistent storage** - Your data stays on the droplet

## Migration from Fly.io

If you were using Fly.io:

1. Export any data you need from Fly
2. Delete your Fly app: `fly apps destroy today-scheduler`
3. Follow the setup steps above
4. Your scheduler will resume on DigitalOcean

## Support

- [DigitalOcean Documentation](https://docs.digitalocean.com/)
- [DigitalOcean Community](https://www.digitalocean.com/community)
- [Droplet Console Access](https://cloud.digitalocean.com/droplets) (if SSH fails)