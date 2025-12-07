# Today

A personal command center for daily planning and productivity. Uses AI-assisted daily reviews, markdown-based task management, and integrations with email, calendar, and time tracking to help you decide what to do each day.

## Features

- **AI-Powered Daily Reviews** - Claude-assisted morning reviews that synthesize calendar events, tasks, emails, and time tracking into actionable daily plans
- **Vault-Based Task Management** - Markdown files using [Obsidian Tasks](https://publish.obsidian.md/tasks/) syntax for portable, version-controlled tasks
- **Stage Themes** - Focus different days on different types of work (front-stage, back-stage, off-stage)
- **Multi-Source Sync** - Pull data from Google Calendar, iCloud, email (IMAP), Toggl time tracking, and more
- **Local-First** - All data stored in local markdown files; sync to cloud services is optional

## Quick Start

```bash
# Clone the repository
git clone https://github.com/jeffcovey/today.git
cd today

# Install dependencies
npm install

# Copy configuration templates
cp config.toml.example config.toml
cp .env.example .env

# Edit config.toml with your preferences (timezone, profile, etc.)
# Edit .env with your API keys and credentials

# Initialize your vault (first run only)
bin/today

# Run daily sync and review
bin/sync && bin/today
```

## Prerequisites

- **Node.js 20+** (or use the devcontainer)
- **Python 3.10+** (for `bin/today`)
- **Anthropic API key** (for AI features)

Optional:
- Google Calendar service account
- iCloud account for calendar sync
- IMAP email account
- Toggl account for time tracking

## Configuration

### config.toml

Non-secret configuration lives in `config.toml`. Copy from the example:

```bash
cp config.toml.example config.toml
```

Key settings:

```toml
# Your timezone
timezone = "America/New_York"

[profile]
name = "Your Name"
email = "you@example.com"
wake_time = "06:00"
bed_time = "21:30"

# Day-of-week themes
[stages]
monday = "front"     # Outward-facing: meetings, calls, emails
tuesday = "back"     # Maintenance: bills, bug fixes, organizing
wednesday = "front"
thursday = "back"
friday = "off"       # Personal: nature, friends, hobbies
saturday = "off"
sunday = "back"

[ai]
claude_model = "claude-sonnet-4-20250514"
```

### Environment Variables (.env)

Secrets and credentials go in `.env`. The file is encrypted using [dotenvx](https://dotenvx.com/).

```bash
cp .env.example .env
# Edit .env with your credentials
npx dotenvx encrypt  # Encrypt the file
```

Key variables:

| Variable | Description |
|----------|-------------|
| `TODAY_ANTHROPIC_KEY` | Anthropic API key for AI features |
| `EMAIL_ACCOUNT` / `EMAIL_PASSWORD` | IMAP email credentials |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Base64-encoded Google service account JSON |
| `GOOGLE_CALENDAR_IDS` | Comma-separated calendar IDs |
| `ICLOUD_USERNAME` / `ICLOUD_APP_PASSWORD` | iCloud credentials |
| `TOGGL_API_TOKEN` | Toggl time tracking API token |

See `.env.example` for the full list.

## Vault Structure

Your personal data lives in the `vault/` directory. On first run, `bin/today` will offer to initialize it from the `skeleton/` template.

```
vault/
├── Dashboard.md              # Main dashboard with widgets
├── plans/                    # Daily, weekly, monthly plans
│   └── 2025_Q1_01_W01_15.md  # Daily plan for Jan 15, 2025
├── tasks/                    # Task collections
│   ├── tasks.md              # Main task inbox
│   ├── repeating.md          # Recurring tasks
│   └── every_six_weeks.md    # Contact reminders
├── notes/                    # General notes
│   ├── inbox/                # New notes landing zone
│   ├── concerns/             # Issues to address
│   └── progress/             # Progress updates
├── projects/                 # Project files
├── topics/                   # Topic-based notes
├── templates/                # Note templates
├── scripts/                  # DataviewJS widgets
└── logs/                     # Sync status, time tracking
```

The vault is designed to work standalone or with [Obsidian](https://obsidian.md/).

**Important:** The `vault/` directory is gitignored because it contains personal data. Initialize it as a separate repository or sync it with your preferred solution (Resilio Sync, Syncthing, iCloud, etc.).

## Main Commands

### bin/today

The main command for daily planning. Runs an AI-assisted review session.

```bash
bin/today                      # Interactive daily review
bin/today update               # Update review file via API
bin/today --no-sync            # Skip sync step
bin/today "specific request"   # Focused session with a request
```

### bin/sync

Synchronizes all data sources.

```bash
bin/sync                       # Full sync
bin/sync --calendar            # Sync calendars only
bin/sync --email               # Sync email only
bin/sync --toggl               # Sync time tracking only
```

### bin/tasks

Manage tasks from markdown files.

```bash
bin/tasks list                 # List all active tasks
bin/tasks list --today         # Show today's tasks
bin/tasks sync                 # Sync tasks from vault files
bin/tasks add "Task" --date 2025-01-20
```

### bin/email

Email management.

```bash
bin/email list                 # List recent emails
bin/email list --unread        # Show unread emails
bin/email download             # Download emails to local cache
```

### bin/calendar

Calendar operations.

```bash
bin/calendar today             # Show today's events
bin/calendar week              # Show this week's events
bin/calendar sync              # Sync calendars to database
```

### bin/track

Time tracking integration.

```bash
bin/track                      # Show current timer status
bin/track start "Task"         # Start a timer
bin/track stop                 # Stop current timer
```

## Task Syntax

Tasks use [Obsidian Tasks](https://publish.obsidian.md/tasks/) syntax:

```markdown
- [ ] Task description ⏫ 📅 2025-01-15 🔁 every week
```

### Priority Markers

| Marker | Priority |
|--------|----------|
| 🔺 | Urgent/highest |
| ⏫ | High |
| 🔼 | Medium |
| 🔽 | Low |

### Date Markers

| Marker | Meaning |
|--------|---------|
| 📅 YYYY-MM-DD | Due date |
| ⏳ YYYY-MM-DD | Scheduled date |
| ➕ YYYY-MM-DD | Created date |
| ✅ YYYY-MM-DD | Completion date |

### Stage Tags

Focus different days on different types of work:

- `#stage/front-stage` - Meetings, calls, support, emails
- `#stage/back-stage` - Maintenance, bills, bug fixes, organizing
- `#stage/off-stage` - Personal time, nature, friends, reading

## Development

### Using the Devcontainer

The easiest way to develop is using VS Code's devcontainer:

1. Install [Docker](https://www.docker.com/) and [VS Code](https://code.visualstudio.com/)
2. Install the [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension
3. Open this folder in VS Code
4. Click "Reopen in Container" when prompted

### Running Tests

```bash
npm test                       # Run all tests
npm run test:watch             # Watch mode
npm run test:coverage          # Coverage report
```

### Linting

```bash
npm run lint                   # Lint markdown files
npm run lint:md:fix            # Auto-fix markdown issues
```

## Documentation

- [Email Setup Guide](docs/EMAIL_SETUP.md) - Configure email integration
- [Vault README](skeleton/README.md) - Detailed vault documentation

## License

MIT
