# Daily Review Session

## How This Works

This file starts an interactive Claude session for your daily review. The `bin/today` script:
1. Checks Claude authentication
2. Syncs all data sources
3. Updates the SQLite database with comprehensive content
4. Creates both today's and tomorrow's plan files (if they don't exist)
5. Starts this interactive session where Claude will **IMMEDIATELY**:
   - Query the database for comprehensive daily data
   - Populate today's plan file at `vault/plans/YYYY_QQ_MM_W##_DD.md` with:
     - Categorized priorities from database
     - Time blocks scheduled around calendar events
     - Status summary with urgent items
   - Populate tomorrow's plan file at `vault/plans/YYYY_QQ_MM_W##_{DD+1}.md` with:
     - Preliminary priorities and upcoming events
     - Draft time blocks based on stage theme
   - Create calendar time blocking events for TODAY's top 5-6 priorities
   - Then remain available for follow-up questions and tasks

**NO WAITING FOR APPROVAL** - Claude should complete all these steps automatically in the first response.

<details>
<summary>
## Session Instructions for Claude
</summary>

### 🔴 CRITICAL FIRST STEPS 🔴

1. **Calculate Day of Week** (NEVER infer from activities)
   - January 1, 2025 was Wednesday
   - Calculate days from Jan 1 (not counting Jan 1 itself)
   - Divide by 7: remainder determines day
   - Verify calculation before proceeding

2. **Get Current Time** (timezone from config.toml)

   ```bash
   TZ=$(bin/get-config timezone) date '+%A, %B %d, %Y at %I:%M %p %Z'
   ```

   - NEVER guess time - always use this command
   - Database uses UTC - convert to local time based on config.toml setting

3. **Query Database Using Pre-Approved Script**

   ```bash
   # Get comprehensive daily review data (pre-approved command)
   bin/db-query daily
   
   # Or query specific data types:
   bin/db-query tasks      # Priority tasks
   bin/db-query events     # Calendar events
   bin/db-query emails     # Recent emails
   bin/db-query contacts   # Contact follow-ups
   bin/db-query ogm        # OGM monitoring
   bin/db-query journal    # Journal entries
   ```

   - Use the `bin/db-query` script for ALL database queries
   - This avoids approval prompts for sqlite3 commands
   - For custom queries: `bin/db-query custom "SELECT ..."`

4. **Check Guest Room Status**
   - Use `bin/db-query daily` which includes guest room section
   - Two rooms need tracking
   - Checkout: 12 PM, Check-in: 3 PM (prep time needed)

5. **Review Hierarchical Plans** (BEFORE creating today's plan)
   - Year: `vault/plans/YYYY_00.md`
   - Quarter: `vault/plans/YYYY_QQ_00.md`
   - Month: `vault/plans/YYYY_QQ_MM_00.md`
   - Week: `vault/plans/YYYY_QQ_MM_W##_00.md`
   - Today: `vault/plans/YYYY_QQ_MM_W##_DD.md`

6. **Check Existing Review**
   - If exists: Query only recent changes, update incrementally
   - If new: Create comprehensive analysis from full database

### Plan Files Structure

Hierarchical naming ensures proper sorting:
- **Yearly**: `YYYY_00.md` (e.g., `2025_00.md`)
- **Quarterly**: `YYYY_QQ_00.md` (e.g., `2025_Q3_00.md`)
- **Monthly**: `YYYY_QQ_MM_00.md` (e.g., `2025_Q3_08_00.md`)
- **Weekly**: `YYYY_QQ_MM_W##_00.md` (e.g., `2025_Q3_08_W33_00.md`)
- **Daily**: `YYYY_QQ_MM_W##_DD.md` (e.g., `2025_Q3_08_W33_16.md`)

The `_00` suffix for aggregates ensures they sort before child items.

### Review File Format

- **USE DAILY PLAN TEMPLATE**: Start with `vault/templates/daily-plan.md` as base
- Template includes:
  - Task query callouts (Due/Scheduled, Plan Tasks, Completed)
  - Morning & Evening routines as collapsible callouts
  - Flexible time blocks for AI to fill
- Template placeholders are auto-replaced by `bin/today`:
  - Date variables: `{{DAY_OF_WEEK}}`, `{{MONTH_NAME}}`, `{{DAY}}`, `{{YEAR}}`, `{{FULL_DATE}}`
  - Stage variables: `{{STAGE_THEME}}`, `{{STAGE_FOCUS}}`
- Time blocks left empty for manual/AI filling:
  - Morning, afternoon, evening sections ready for planning
  - Top priorities section has empty checkboxes to fill
- **TASK FORMATTING IN PLAN FILES**:
  - Use simple checkboxes ONLY: `- [ ] Task description`
  - DO NOT add due dates (📅) or scheduled dates (⏳)
  - DO NOT add recurrence (🔁 every week, etc.)
  - Created date (➕) is fine - scripts add this automatically as metadata
  - Plan files are for daily coordination - scheduling belongs in project/topic files
- For incremental updates: Use `<details><summary>` tags to collapse old content

### Daily Plan Updates

For existing daily plans:
- Tasks update automatically via Obsidian Tasks queries
- Add progress notes with timestamps: `### Update (2:30 PM)`
- Check off completed tasks directly in Obsidian
- Evening reflection section for end-of-day review

### Time Blocking Workflow

After creating or updating daily plans:
1. **Identify Priority Tasks**: Select 3-5 most important tasks from the daily plan
2. **Create Time Blocks**: Use `bin/calendar add` to create focused calendar events
3. **Structure the Day**:
   - Urgent tasks: 15-30 minute blocks
   - Deep work: 1-2 hour focused blocks
   - Routine tasks: 30-45 minute blocks
   - Evening routine: 3+ hour wind-down block
4. **Use Time Blocking Calendar**: Always specify `--calendar "e1jdfoki06hfrg8kh55mn9kvvs@group.calendar.google.com"`

### Available Commands

```bash
# Task management (Obsidian-based)
bin/today                              # Create daily plan from template
bin/tasks sync                         # NO LONGER syncs to database (disabled)
# Tasks are now managed directly in markdown files with Obsidian Tasks plugin:
# - [ ] Task title 🔺 ⏳ 2025-09-20    # Priority + scheduled date
# - [ ] Task title 📅 2025-09-21 🔁 every week  # Due date + recurrence

# Calendar time blocking
bin/calendar add --title "Task" --date "YYYY-MM-DD" "HH:MM" "HH:MM" --calendar "e1jdfoki06hfrg8kh55mn9kvvs@group.calendar.google.com"
bin/calendar list-calendars            # Show available calendars

# Review tracking
bin/mark-done "Task description"       # Mark specific task as done
bin/progress "Additional note"         # Add a progress note

# Data sync
bin/sync                               # Sync all data sources
```

</details>

## Guidelines

### About Me

Jeffrey Covey ("Jeff") - see contacts database for details.

### Schedule & Timezone

**🚨 Check config.toml for current timezone setting!**
- Current timezone configured in `config.toml`
- Edit when traveling: `timezone = "America/Los_Angeles"` etc.
- Home: Oakland Park, Florida
- Wake: ~5:30-6:00 AM (1hr morning routine)
- Bed: ~9:30 PM (offline last 2 hours)

### Vocation

Retired, devoted to https://oldergay.men/ - a website for older gay men and their admirers. Check `ogm_*` tables for production issues (GitHub issues, HoneyBadger errors, Scout APM metrics).

### Daily Structure

**Stage Themes** (calculate day, don't infer from activities):
- **Front Stage** (Mon/Wed/Sat): Meetings, calls, support, emails
- **Back Stage** (Thu/Sun): Maintenance, bills, bug fixes, organizing
- **Off Stage** (Tue/Fri): Personal time, nature, friends, reading

### Streaks & Habits

`vault/logs/Streaks.md` - tracks uncompleted tasks from Streaks app for daily health and habit goals.

### Apple Health Data

Health metrics are automatically extracted from the most recent health export file in `vault/logs/`:
- Formats supported: `HealthAutoExport-YYYY-MM-DD-YYYY-MM-DD.json` or `HealthAutoExport.zip`
- The script finds the most recent file by modification time (looks for any file matching `HealthAutoExport*.json` or `HealthAutoExport*.zip`)
- Extracted metrics include:
  - Daily step counts and weekly averages
  - Weight tracking trends
  - Workout history (type, duration, calories)
  - Alcohol consumption patterns
  - Sleep analysis and breathing disturbances
  - Heart rate variability and resting heart rate

The `bin/today` script automatically finds and extracts key health metrics from the most recent export file and includes them in the daily review context.

### Hosting

Two guest rooms via Airbnb/MisterB&B:
- Check-out: 12 PM (clean after)
- Check-in: 3 PM (prep before)

### Contact Tracking

6-week follow-up system for close friends:
- Query: `SELECT * FROM contacts WHERE julianday('now') - julianday(last_contacted) > 42`
- Update: `UPDATE contacts SET last_contacted = DATE('now') WHERE full_name = 'Name'`
- Great "Off Stage" activity for Tue/Fri

### Calendar Time Blocking

**Time Blocking Calendar ID**: `e1jdfoki06hfrg8kh55mn9kvvs@group.calendar.google.com`

Create focused time blocks for daily priorities:
- **Urgent tasks**: 15-30 minute blocks
- **Deep work**: 1-2 hour focused blocks
- **Routine tasks**: 30-45 minute blocks
- **Evening routine**: 3+ hour wind-down block

**Usage**: After creating or updating daily plans, proactively create calendar events to structure the day with focused time blocks.

### Hierarchical Goal Alignment

**Minimize busy work - every task should ladder up to life goals:**

1. **Year Plan** - Values, principles, annual objectives
2. **Quarter Plan** - 3-month initiatives advancing yearly goals
3. **Month Plan** - Specific projects and deliverables
4. **Week Plan** - Concrete tasks and time allocations
5. **Today's Plan** - Daily actions supporting weekly/monthly goals

Tasks should either:
- Advance mission/purpose from year plan
- Support health/wellbeing
- Nurture relationships
- Maintain infrastructure
- Bring aligned joy

Question/delegate/eliminate tasks that don't fit.

## Data Sources

SQLite database at `.data/today.db` contains:

### Core Tables

- **markdown_tasks**: Tasks cached from markdown files in vault/
- **emails**: Received (iCloud) and sent (Pobox via `bin/pobox-sync`)
- **calendar_events**: Events with timezone data
- **contacts**: Contact info with normalized data
- **diary**: Day One journal entries from `vault/logs/Journal.json`
- **file_tracking**: Recently modified files
- **toggl_time_entries**: Time tracking data

### OGM Monitoring

- **ogm_github_issues**: Bugs and features
- **ogm_scout_metrics**: Performance data
- **ogm_sentry_issues**: Error tracking
- **ogm_summary_stats**: Daily aggregates

<details>
<summary>
### Essential SQL Queries
</summary>

```sql
-- Tasks (tracked in markdown files)
-- Use: rg '- \[ \]' vault/ to see uncompleted tasks
-- Or query markdown_tasks table for cached data

-- Unread emails
SELECT subject, from_address, date
FROM emails
WHERE has_been_replied_to = 0
  AND date > datetime('now', '-3 days')
  AND folder != 'Sent'
ORDER BY date DESC;

-- Today's events (with timezone conversion)
SELECT title, start_date, end_date, location, start_timezone
FROM calendar_events
WHERE DATE(start_date) = DATE('now')
ORDER BY start_date;

-- Overdue contacts (6+ weeks)
SELECT full_name, last_contacted,
       CAST((julianday('now') - julianday(last_contacted)) / 7 AS INTEGER) as weeks_ago
FROM contacts
WHERE julianday('now') - julianday(last_contacted) > 42
ORDER BY last_contacted;

-- OGM errors (from Sentry)
SELECT title, count, last_seen
FROM ogm_sentry_issues
WHERE status = 'unresolved' AND count > 100
ORDER BY count DESC;

-- Today's time tracking
SELECT COALESCE(p.name, 'No Project') as project,
       printf('%.2f', SUM(te.duration) / 3600.0) as hours
FROM toggl_time_entries te
LEFT JOIN toggl_projects p ON te.pid = p.id
WHERE DATE(te.start) = DATE('now', 'localtime')
GROUP BY p.name;

-- Recent journal entries
SELECT DATE(creation_date) as date,
       SUBSTR(text, 1, 200) as preview,
       starred
FROM diary
WHERE datetime(creation_date) >= datetime('now', '-7 days')
ORDER BY creation_date DESC;
```

</details>

## Task Creation Workflow

### For urgent tasks during review

Tasks are managed directly in markdown files using Obsidian Tasks syntax:

```markdown
- [ ] Task title 📅 YYYY-MM-DD ⏫
- [ ] Task title 📅 YYYY-MM-DD 🔼
```

## DEPRECATED: No longer using task-id with Obsidian Tasks

Tasks are now managed with Obsidian Tasks syntax

### Project files in `vault/projects/`

- Use kebab-case: `palm-springs-trip.md`
- Start with `# Project Name`
- Include metadata: Dates, Status, Budget, Location
- Tasks auto-associate with project during sync

## What I Need From You

Based on database queries AND hierarchical plan alignment:

1. **Current Status** - What's urgent? What patterns? What aligns with goals?
2. **Top 3-5 Priorities** - Filtered through year/quarter/month objectives
3. **Quick Wins** - Under 15 minutes
4. **Deep Work** - 1-2 hour focused block
5. **Communications** - Check both received AND sent emails
6. **Evening Planning** - Review and prepare
7. **Self-Care** - Check journal entries for wellbeing patterns
8. **Time Tracking** - Analyze tracked vs planned, alignment with priorities
9. **Health Metrics** - Review step counts, weight trends, workout consistency, alcohol patterns
10. **Time Blocking** - Create focused calendar events for priorities using the "Time Blocking" calendar

## Your First Steps - DO ALL IN FIRST RESPONSE

**CRITICAL:** All of these steps must be completed automatically in your FIRST response. Do NOT present analysis and wait for approval.

1. **Query database** - Use `bin/db-query daily` (pre-approved, no permission needed)
2. **Calculate current time/day** - Already provided in pre-computed context
3. **Populate TODAY's plan file** at `vault/plans/YYYY_QQ_MM_W##_DD.md`:
   - Fill in "Top Priorities" section with categorized tasks from database:
     - 🚨 Critical (Do First) - High priority urgent items
     - ⚡ Quick Wins (<15 min)
     - 📞 Communications
     - 🏠 Home & Hosting
     - ⚠️ System Alerts
   - Fill in time blocks (Morning/Afternoon/Evening) with:
     - Calendar events from database
     - Scheduled work blocks around those events
   - Add status summary in Reflection section with:
     - Stage theme focus
     - Urgent items needing attention
     - System health issues
     - Wins/achievements
4. **Populate TOMORROW's plan file** at `vault/plans/YYYY_QQ_MM_W##_{DD+1}.md`:
   - Add preliminary priorities based on overdue tasks and upcoming deadlines
   - Note calendar events scheduled for tomorrow
   - Suggest time blocks based on tomorrow's stage theme
   - Keep it lightweight - this is a draft to refine throughout today
5. **Create calendar time blocks for TODAY** - Immediately run `bin/calendar add` for top 5-6 priorities:
   - Schedule around existing calendar events
   - Include evening routine block
   - Use pre-approved calendar: `e1jdfoki06hfrg8kh55mn9kvvs@group.calendar.google.com`
6. **Confirm completion** - Brief summary of what was done
7. **Stay engaged** - Then remain available for follow-up questions

**DO NOT:**
- Present analysis and wait for permission
- Ask if user wants time blocks created
- Provide recommendations without taking action first

**This is automation, not consultation.** Execute immediately, then be available for adjustments.
