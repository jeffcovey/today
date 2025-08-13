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
bin/notion --sync              # Alternative: Sync with Todoist
```

### Sync Commands

#### Sync Commands

Sync tasks between Notion and Todoist using the unified `notion` command.

```bash
bin/notion sync --dry-run          # Preview sync without making changes
bin/notion sync                    # Perform two-way sync
bin/notion sync --notion-to-todoist # One-way: Notion → Todoist
bin/notion sync --todoist-to-notion # One-way: Todoist → Notion
bin/notion sync --project "Work"   # Use custom Todoist project

# Alternative syntax
bin/notion --sync --dry-run        # Using -- prefix
```

#### `bin/sync-scheduler`

Automated sync scheduler for background synchronization.

```bash
bin/sync-scheduler                 # Start continuous sync (every 15 min)
bin/sync-scheduler --once          # Run single sync and exit
bin/sync-scheduler --config        # Show current configuration
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

### First-Time Sync Setup

```bash
# 1. Preview what will be synced
bin/notion sync --dry-run

# 2. If everything looks good, run the sync
bin/notion sync

# 3. Set up automated sync
bin/sync-scheduler
```

### Daily Workflow

```bash
# Morning: Run daily automation
bin/notion daily --all

# Throughout the day: Edit tasks interactively
bin/notion edit

# Check sync status
bin/sync-scheduler --config
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
TODOIST_TOKEN=your_todoist_token_here  # Only for sync features
```

## Configuration Files

- `.env` - API tokens and environment settings
- `.sync-config.json` - Sync scheduler configuration
- `.sync-log.json` - Sync operation logs
- `.data/` - SQLite database directory
