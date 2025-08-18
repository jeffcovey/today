# Sync Setup Guide

## Overview

The Today system synchronizes multiple data sources to provide a unified view of your tasks, notes, and schedule:

- **GitHub**: Sync notes and documentation
- **Notion**: Import tasks and projects from databases
- **Task Manager**: Local SQLite-based task management with Markdown sync
- **Email**: Fetch and cache emails for review
- **Calendar**: Import events from Google Calendar and iCloud
- **Contacts**: Sync contact information

## Setup Instructions

### 1. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

### 2. Required Configurations

#### Notion Integration
```bash
# Get from https://www.notion.so/my-integrations
NOTION_TOKEN=your_notion_integration_token_here
```

#### Email Setup (IMAP)
```bash
EMAIL_ACCOUNT=your.email@gmail.com
EMAIL_PASSWORD=your_app_password_here
EMAIL_HOST=imap.gmail.com
EMAIL_PORT=993
```

#### Google Calendar
```bash
# Create service account at https://console.cloud.google.com/
GOOGLE_SERVICE_ACCOUNT_KEY=base64_encoded_json_key_here
GOOGLE_CALENDAR_IDS=primary,work@group.calendar.google.com
```

#### iCloud Calendar
```bash
# Get app-specific password from https://appleid.apple.com
ICLOUD_USERNAME=your@icloud.com
ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

### 3. Run Full Sync

Execute the main sync script to pull all data:

```bash
bin/sync
```

This will:
1. Pull latest notes from GitHub
2. Sync Notion databases to local cache
3. Sync tasks between Markdown files and database
4. Fetch new emails
5. Import calendar events
6. Update contact information
7. Process inbox items
8. Archive completed tasks

### 4. Automated Sync

#### Using Cron
Add to your crontab for hourly sync:
```bash
0 * * * * cd /path/to/today && bin/sync
```

#### Using systemd Timer
Create a service file for Linux systems with systemd.

#### Using launchd (macOS)
Create a LaunchAgent for automatic syncing on macOS.

## Task Management

The built-in task manager syncs between SQLite and Markdown files:

### File Structure
- `vault/notes/tasks/tasks.md` - Main task list
- `vault/notes/tasks/today.md` - Auto-generated daily tasks
- `vault/projects/*.md` - Project-specific tasks

### Task Format
Tasks in Markdown include unique IDs:
```markdown
- [ ] Task title <!-- task-id: unique-id-here --> <!-- task-id: 6b6041280977d040be271ac4b188042f -->
```

### Sync Process
1. Reads all task files
2. Adds IDs to new tasks
3. Updates database with changes
4. Generates today.md with current tasks
5. Processes repeating tasks

## Performance Optimization

### Caching Strategy
- SQLite database stores all synced data
- Incremental sync only fetches changes
- Cache TTL configured per data source

### Sync Frequency
Recommended intervals:
- GitHub notes: Every sync (quick)
- Notion: Every 15-30 minutes
- Tasks: Every sync (instant)
- Email: Every hour
- Calendar: Every 2-4 hours

## Troubleshooting

### Common Issues

1. **Sync fails with permission error**
   - Check that all tokens are valid
   - Ensure database file has write permissions

2. **Tasks not appearing in today.md**
   - Set do_date on tasks
   - Run `bin/tasks sync` manually

3. **Notion sync is slow**
   - Use cached mode by default
   - Force refresh only when needed

### Debug Mode
Enable verbose logging:
```bash
DEBUG=1 bin/sync
```

### Manual Sync
Sync individual components:
```bash
bin/tasks sync           # Tasks only
bin/notion fetch-tasks   # Notion only
bin/email fetch          # Email only
```

## Best Practices

1. **Start with partial sync** - Configure one service at a time
2. **Monitor first runs** - Check logs for errors
3. **Use incremental sync** - Avoid full refreshes unless necessary
4. **Set up automation** - Use cron or similar for regular syncs
5. **Regular backups** - Back up `.data/today.db` periodically