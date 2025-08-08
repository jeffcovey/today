# Notion CLI Bin Scripts

All scripts are located in the `bin/` directory and can be executed directly without `node` or `npm`.

## Available Scripts

### Core Commands

#### `bin/notion-cli`
Main CLI entry point for all Notion operations.
```bash
bin/notion-cli --help              # Show all available commands
bin/notion-cli edit                # Interactive task editing mode
bin/notion-cli clear-cache         # Clear all cached data
bin/notion-cli cache-info          # Show cache statistics
bin/notion-cli tag-review          # Review and categorize untagged items
bin/notion-cli debug               # Debug database items
```

#### `bin/notion-edit`
Quick access to interactive editing mode.
```bash
bin/notion-edit                    # Start interactive task editor
```

### Sync Commands

#### `bin/notion-sync`
Sync tasks between Notion and Todoist.
```bash
bin/notion-sync --dry-run          # Preview sync without making changes
bin/notion-sync                    # Perform two-way sync
bin/notion-sync --notion-to-todoist # One-way: Notion → Todoist
bin/notion-sync --todoist-to-notion # One-way: Todoist → Notion
bin/notion-sync --project "Work"   # Use custom Todoist project
```

#### `bin/sync-scheduler`
Automated sync scheduler for background synchronization.
```bash
bin/sync-scheduler                 # Start continuous sync (every 15 min)
bin/sync-scheduler --once          # Run single sync and exit
bin/sync-scheduler --config        # Show current configuration
```

### Automation Commands

#### `bin/notion-daily`
Run daily automation tasks.
```bash
bin/notion-daily --all             # Run all daily tasks
bin/notion-daily --reset-routines  # Reset routine checkboxes
bin/notion-daily --mark-repeating-tasks # Reset completed repeating tasks
bin/notion-daily --create-temporal # Create missing days/weeks
```

## Quick Start Examples

### First-Time Sync Setup
```bash
# 1. Preview what will be synced
bin/notion-sync --dry-run

# 2. If everything looks good, run the sync
bin/notion-sync

# 3. Set up automated sync
bin/sync-scheduler
```

### Daily Workflow
```bash
# Morning: Run daily automation
bin/notion-daily --all

# Throughout the day: Edit tasks interactively
bin/notion-edit

# Check sync status
bin/sync-scheduler --config
```

### Troubleshooting
```bash
# Check cache status
bin/notion-cli cache-info

# Clear cache if needed
bin/notion-cli clear-cache

# Debug specific issues
bin/notion-cli debug --list-all-dbs
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
# Create symlinks in /usr/local/bin
sudo ln -s /path/to/notion-cli/bin/notion-sync /usr/local/bin/notion-sync
sudo ln -s /path/to/notion-cli/bin/notion-edit /usr/local/bin/notion-edit
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
TODOIST_TOKEN=your_todoist_token_here  # Only for sync features
```

## Configuration Files

- `.env` - API tokens and environment settings
- `.sync-config.json` - Sync scheduler configuration
- `.sync-log.json` - Sync operation logs
- `.notion-cache/` - SQLite cache directory