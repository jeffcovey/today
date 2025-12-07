# Vault

This is your personal vault directory for the Today system. It contains your notes, tasks, plans, and projects.

## Important: Private Repository

**This directory is excluded from the main Today repository** because it contains your personal data. You should:

1. **Initialize a separate git repository** for version control:

   ```bash
   cd vault
   git init
   git add .
   git commit -m "Initial vault setup"
   ```

2. **Set up your own sync solution** (optional but recommended):
   - [Resilio Sync](https://www.resilio.com/) - Peer-to-peer sync across devices
   - [Syncthing](https://syncthing.net/) - Open source alternative
   - Private git remote (GitHub, GitLab, etc.)
   - iCloud/Dropbox/Google Drive

## Obsidian Integration

This vault is designed to work standalone, but has features that work especially well with [Obsidian](https://obsidian.md/).

### Recommended Plugins

Install these community plugins for the best experience:

| Plugin | Purpose |
|--------|---------|
| **Dataview** | Dynamic queries and dashboards |
| **Tasks** | Task management with dates, priorities, recurrence |
| **Templater** | Advanced templates with dynamic content |
| **Calendar** | Visual calendar navigation |
| **Periodic Notes** | Daily/weekly/monthly notes |
| **Meta Bind** | Interactive inputs in notes |
| **Projects** | Kanban boards and project views |

### Recommended Settings

1. **Files & Links**
   - Default location for new notes: `notes/inbox`
   - Default location for attachments: `projects/zz-attachments`

2. **Core Plugins**
   - Enable: Daily notes, Templates, Outgoing links, Backlinks, Tags

3. **Appearance**
   - Consider a clean theme like Minimal or California Coast
   - Enable the CSS snippet: Settings → Appearance → CSS Snippets → Enable `app-wide`

## Directory Structure

```
vault/
├── Dashboard.md              # Main dashboard with widgets
├── logs/                     # System logs and data
│   ├── sync/                 # Sync status files
│   └── time-tracking/        # Time tracking entries
├── notes/                    # Your notes
│   ├── .trash/               # Deleted notes
│   ├── concerns/             # Issues to address
│   ├── general/              # General notes
│   ├── inbox/                # New notes landing zone
│   └── progress/             # Progress updates
├── plans/                    # Daily, weekly, monthly, quarterly, yearly plans
├── projects/                 # Project files
│   └── zz-attachments/       # Project attachments
├── scripts/                  # DataviewJS widgets
├── tasks/                    # Task collections
│   ├── tasks.md              # Main task inbox
│   ├── repeating.md          # Recurring tasks
│   └── every_six_weeks.md    # Six-week recurring tasks
├── templates/                # Note templates
│   ├── daily-plan.md         # Daily plan template
│   └── project.md            # Project template
└── topics/                   # Topic-based notes
```

## Task Syntax

Tasks use [Obsidian Tasks](https://publish.obsidian.md/tasks/) syntax:

```markdown
- [ ] Task description ⏫ 📅 2025-01-15 🔁 every week
```

### Priority Markers

- 🔺 - Urgent/highest
- ⏫ - High
- 🔼 - Medium
- 🔽 - Low

### Date Markers

- 📅 YYYY-MM-DD - Due date
- ⏳ YYYY-MM-DD - Scheduled date
- ➕ YYYY-MM-DD - Created date
- ✅ YYYY-MM-DD - Completion date

### Stage Tags

The "Stage" system helps focus on different types of work on different days:

- `#stage/front-stage` - External-facing: meetings, calls, support, emails
- `#stage/back-stage` - Internal: maintenance, bills, bug fixes, organizing
- `#stage/off-stage` - Personal: nature, friends, reading, hobbies

## Plan Naming Convention

Plans follow a hierarchical naming pattern:

```
YYYY_00.md           # Yearly plan
YYYY_Q#_00.md        # Quarterly plan
YYYY_Q#_MM_00.md     # Monthly plan
YYYY_Q#_MM_W##_00.md # Weekly plan
YYYY_Q#_MM_W##_DD.md # Daily plan
```

The `_00` suffix indicates an aggregate/summary file for that level.

## Time Tracking

Time tracking uses simple text files in `logs/time-tracking/`:

- `current-timer.md` - Currently running timer
- `YYYY-MM.md` - Monthly time entries

Format: `START_ISO|END_ISO|Description #topic/tag`

Use the Dashboard widget to start/stop timers.

## Getting Help

- Check the main Today repository README
- Run `bin/today` for AI-assisted daily planning
- Run `bin/sync` to sync data sources
