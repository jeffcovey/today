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
- Build the Docker containers (Today CLI and Ollama)
- Start both containers

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

- `bin/docker-run up` - Start containers in background
- `bin/docker-run down` - Stop containers
- `bin/docker-run exec` - Enter the running container
- `bin/docker-run build` - Rebuild container image
- `bin/docker-run restart` - Stop and restart containers
- `bin/docker-run logs` - View container logs

### Ollama Management

Manage local AI models (runs in separate container):

- `bin/ollama-manage list` - List installed models
- `bin/ollama-manage pull <model>` - Download a model
- `bin/ollama-manage rm <model>` - Remove a model
- `bin/ollama-manage test [model]` - Test a model

Recommended model for quick start:

```bash
bin/ollama-manage pull tinyllama  # Small, fast model (638MB)
```

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
- Your SSH keys from `~/.ssh` (read-only, for git operations)
- Ollama models in `ollama-data` volume (persist between rebuilds)

### Data Persistence

These directories persist between container runs:
- `notes/` - Your notes and reviews
- `.data/` - SQLite database
- `.sync-config.json` - Sync configuration
- `.data/today.db` - SQLite database with all synchronized data

## Local AI with Ollama

The Docker setup includes Ollama as a separate service for local AI processing. This reduces Claude API usage for simple tasks.

### Benefits

- **Architecture Independence**: Ollama runs in its own container with the correct binary
- **Persistent Models**: Models are stored in Docker volume, survive container rebuilds
- **Automatic Discovery**: Today CLI automatically detects and uses Ollama service
- **Resource Isolation**: Ollama runs independently, won't affect main container

### Setup Ollama

After running `bin/docker-setup`, pull a model:

```bash
# Pull a lightweight model (recommended for start)
bin/ollama-manage pull tinyllama

# Test it works
bin/ollama-manage test
```

### How It Works

- Ollama runs on port 11434 (exposed to host)
- Today CLI connects via `OLLAMA_HOST=http://ollama:11434`
- Used automatically for:
  - Daily summary recommendations
  - Simple email/task searches
  - Basic intent classification

## Troubleshooting

### Git SSH Issues

If you get "Permission denied (publickey)" errors:
1. Ensure your SSH key is added to GitHub
2. Check that your SSH key exists: `ls ~/.ssh/id_*`
3. Test SSH connection: `ssh -T git@github.com`
4. If using a non-standard key name, configure git:

   ```bash
   git config core.sshCommand "ssh -i ~/.ssh/your_key"
   ```

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
