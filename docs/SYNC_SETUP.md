# Notion-Todoist Sync Setup Guide

## Overview

This sync system provides two-way synchronization between your Notion Action Items database and Todoist, allowing you to:
- Work offline with Todoist's fast native apps
- Keep tasks synchronized between both platforms
- Leverage Todoist's natural language input and mobile experience
- Maintain Notion as your central planning hub

## Prerequisites

1. **Notion Integration Token**
   - Already configured if you're using the notion

2. **Todoist API Token**
   - Get yours from: https://todoist.com/app/settings/integrations
   - Click "Developer" tab
   - Copy your API token

## Setup Instructions

### 1. Add Todoist Token to Environment

```bash
echo "TODOIST_TOKEN=your_todoist_token_here" >> .env
```

### 2. Test the Sync

```bash
# Preview what would be synced (dry run)
bin/notion-sync --dry-run

# Run a one-time two-way sync
bin/notion-sync

# Sync only from Notion to Todoist
bin/notion-sync --notion-to-todoist

# Sync only from Todoist to Notion  
bin/notion-sync --todoist-to-notion

# Use a custom project name
bin/notion-sync --project "Work Tasks"
```

## Automated Sync Setup

### Option 1: Run as Background Service

```bash
# Start the sync scheduler (runs every 15 minutes by default)
bin/sync-scheduler

# Run once
bin/sync-scheduler --once

# Check current config
bin/sync-scheduler --config
```

### Option 2: Configure Sync Settings

Create or edit `.sync-config.json`:

```json
{
  "intervalMinutes": 15,
  "projectName": "Notion Tasks",
  "enabled": true,
  "syncDirection": "two-way"
}
```

Sync directions:
- `"two-way"` - Full bidirectional sync (default)
- `"notion-to-todoist"` - One-way from Notion to Todoist
- `"todoist-to-notion"` - One-way from Todoist to Notion

### Option 3: System Cron Job

Add to your crontab (`crontab -e`):

```bash
# Sync every 15 minutes
*/15 * * * * cd /path/to/notion && bin/sync-scheduler --once >> .sync.log 2>&1
```

### Option 4: macOS LaunchAgent

Create `~/Library/LaunchAgents/com.user.notion-todoist-sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.notion-todoist-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/notion/bin/sync-scheduler</string>
        <string>--once</string>
    </array>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>WorkingDirectory</key>
    <string>/path/to/notion</string>
    <key>StandardOutPath</key>
    <string>/tmp/notion-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/notion-sync.error.log</string>
</dict>
</plist>
```

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.user.notion-todoist-sync.plist
```

## How It Works

### Sync Mapping

- The system maintains a mapping between Notion and Todoist task IDs
- Mappings are stored in SQLite cache for persistence
- Tasks are matched by ID, preventing duplicates

### Field Mapping

| Notion Field | Todoist Field |
|-------------|---------------|
| Name/Title | Task Content |
| Do Date | Due Date |
| Status | Completed State |
| Priority | Priority (1-4) |
| Tags | Labels |
| Project | Description (reference) |

### Priority Mapping

- 🔴 Critical → Priority 4 (Red)
- 🟠 High → Priority 3 (Orange)
- 🟡 Medium → Priority 2 (Blue)
- ⚪ Low → Priority 1 (Gray)

### Change Detection

- Uses MD5 hash of task properties to detect changes
- Only syncs tasks that have actually changed
- Prevents unnecessary API calls

### Conflict Resolution

- Last-write-wins strategy
- Most recently edited task overwrites older version
- Manual conflict resolution can be added if needed

## Monitoring

### Check Sync Logs

```bash
# View recent sync results
cat .sync-log.json | jq '.'

# View last sync time
cat .sync-config.json | jq '.lastSync'
```

### Clear Sync Cache

If you need to reset the sync mappings:

```bash
bin/notion clear-cache
```

## Troubleshooting

### Tasks Not Syncing

1. Ensure both tokens are valid
2. Check that tasks have "Do Date" set in Notion
3. Verify the Todoist project exists
4. Check `.sync-log.json` for errors

### Duplicate Tasks

- This usually means the sync mapping was lost
- Clear cache and re-sync: `bin/notion clear-cache && bin/notion-sync`

### Performance Issues

- Reduce sync frequency in `.sync-config.json`
- Use one-way sync if bidirectional isn't needed
- Check API rate limits (Todoist: 450 requests/15 min)

## Best Practices

1. **Start with one-way sync** to test the system
2. **Use descriptive project names** in Todoist
3. **Set reasonable sync intervals** (15-30 minutes recommended)
4. **Monitor logs** for the first few days
5. **Backup your data** before initial setup

## Limitations

- Only syncs tasks with "Do Date" field set
- Subtasks are not currently synced
- Attachments and comments not synced
- Rich text formatting is simplified

## Future Enhancements

- [ ] Webhook support for real-time sync
- [ ] Subtask synchronization
- [ ] Comment sync
- [ ] Custom field mapping configuration
- [ ] Web UI for monitoring sync status
