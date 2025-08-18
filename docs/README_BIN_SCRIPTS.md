# Notion CLI Bin Scripts

All scripts are located in the `bin/` directory and can be executed directly without `node` or `npm`.

## Available Scripts

### Core Commands

#### `bin/notion`

Unified CLI entry point for all Notion operations.

```bash
bin/notion --help              # Show all available commands
bin/notion edit                # Interactive task editing mode
bin/notion clear-cache         # Clear all cached data
bin/notion cache-info          # Show cache statistics
bin/notion tag-review          # Review and categorize untagged items
bin/notion debug               # Debug database items

# Using -- prefix for specific commands
bin/notion --edit              # Alternative: Start interactive editor
bin/notion --daily --all       # Alternative: Run daily automation
```

### Task Management Commands

#### `bin/tasks`

Manage local tasks with Markdown sync.

```bash
bin/tasks sync                     # Sync all markdown files with database
bin/tasks sync vault/notes/tasks/tasks.md # Sync specific file
bin/tasks list                     # List all active tasks
bin/tasks list --today             # Show today's tasks
bin/tasks list --stage inbox      # Filter by stage
bin/tasks add "New task" --date 2025-08-14 --priority 4
bin/tasks update <id> --stage active
bin/tasks done <id>               # Mark task as complete
bin/tasks projects                # List all projects
```

#### `bin/sync`

Main synchronization script for all data sources.

```bash
bin/sync                           # Run full sync of all sources
bin/sync --force                   # Force sync even if recent
```

### Automation Commands

#### Daily Automation

Run daily automation tasks using the unified `notion` command.

```bash
bin/notion daily --all             # Run all daily tasks
bin/notion daily --reset-routines  # Reset routine checkboxes
bin/notion daily --mark-repeating-tasks # Reset completed repeating tasks
bin/notion daily --create-temporal # Create missing days/weeks

# Alternative syntax
bin/notion --daily --all           # Using -- prefix
```

## Quick Start Examples

### First-Time Setup

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 2. Run initial sync
bin/sync

# 3. Check tasks
bin/tasks list --today
```

### Daily Workflow

```bash
# Morning: Run daily automation
bin/notion daily --all

# Throughout the day: Edit tasks interactively
bin/notion edit

# Sync task changes
bin/tasks sync

# View today's tasks
bin/tasks list --today
```

### Troubleshooting

```bash
# Check cache status
bin/notion cache-info

# Clear cache if needed
bin/notion clear-cache

# Debug specific issues
bin/notion debug --list-all-dbs
```

## Making Scripts Globally Available

To use these scripts from anywhere on your system:

### Option 1: Add to PATH

```bash
# Add to your shell profile (.bashrc, .zshrc, etc.)
export PATH="$PATH:/path/to/notion-cli/bin"
```

### Option 2: Create Symlinks

```bash
# Create symlink in /usr/local/bin
sudo ln -s /path/to/notion-cli/bin/notion /usr/local/bin/notion
# ... etc for other scripts
```

### Option 3: Use npm link (if package.json configured)

```bash
npm link
```

## Script Permissions

All scripts should be executable. If not:

```bash
chmod +x bin/*
```

## Environment Variables

Scripts require environment variables in `.env`:

```bash
NOTION_TOKEN=your_notion_token_here
EMAIL_ACCOUNT=your.email@gmail.com
EMAIL_PASSWORD=your_app_password_here
```

## Configuration Files

- `.env` - API tokens and environment settings
- `.sync-config.json` - Sync scheduler configuration
- `.data/` - SQLite database directory (contains all operational data)
