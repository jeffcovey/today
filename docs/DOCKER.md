# Docker Setup Guide

## Quick Start

### Initial Setup (Linux Server)

1. Clone the repository:
```bash
git clone https://github.com/OlderGay-Men/today.git
cd today
```

2. Run the setup script:
```bash
bin/docker-setup
```

This will:
- Prompt for your DOTENV_PRIVATE_KEY
- Create .env.local file
- Build the Docker container
- Start the container

### Daily Usage

Enter the container:
```bash
bin/docker-run exec
```

Inside the container, run your commands:
```bash
bin/sync       # Sync all data sources
bin/today      # Run daily review with Claude
bin/status     # Check task progress
bin/mark-done  # Mark tasks as complete
```

### Updating

From your host machine:
```bash
git pull
bin/docker-run restart
```

Or from inside the container:
```bash
git pull
exit
# Then from host:
bin/docker-run restart
```

## Docker Commands

All Docker commands use `.env.local` automatically if it exists:

- `bin/docker-run up` - Start container in background
- `bin/docker-run down` - Stop container
- `bin/docker-run exec` - Enter the running container
- `bin/docker-run build` - Rebuild container image
- `bin/docker-run restart` - Stop and restart container
- `bin/docker-run logs` - View container logs

## Environment Setup

### Required: DOTENV_PRIVATE_KEY

Create `.env.local` with your decryption key:
```bash
echo 'DOTENV_PRIVATE_KEY=your-key-here' > .env.local
```

Get your key from your local machine:
```bash
echo $DOTENV_PRIVATE_KEY
```

### Volume Mounts

The docker-compose.yml mounts:
- Entire project directory at `/app`
- Named volumes for caches (persist between rebuilds)
- Isolated node_modules (container-specific)

### Data Persistence

These directories persist between container runs:
- `notes/` - Your notes and reviews
- `.notion-cache/` - Notion data cache
- `.calendar-cache/` - Calendar data cache
- `.sync-config.json` - Sync configuration
- `.sync-log.json` - Sync history
- `SUMMARY.json` - Daily summary data

## Troubleshooting

### Permission Issues
If you get permission errors, ensure your user owns the files:
```bash
sudo chown -R $USER:$USER .
```

### Container Won't Start
Check logs:
```bash
bin/docker-run logs
```

### Can't Access Git
The entire project directory is mounted, so git should work. If not:
```bash
# Restart the container
bin/docker-run restart
```

### Missing Dependencies
Rebuild the container:
```bash
bin/docker-run build
bin/docker-run restart
```