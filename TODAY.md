# Daily Review Session

## How This Works

This file starts an interactive Claude session for your daily review. The `bin/today` script:
1. Checks Claude authentication
2. Syncs all data sources
3. Updates the SQLite database with comprehensive content
4. Starts this interactive session where Claude will:
   - Review all your data
   - Create or update today's plan file in `vault/plans/YYYY_QQ_MM_W##_DD.md`
   - Provide recommendations based on your schedule and priorities
   - Continue working with you as long as needed

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

3. **Check Database Schema FIRST**

   ```sql
   -- ALWAYS check table structure before querying!
   .schema task_cache
   .schema emails
   .schema calendar_events
   ```

   - Verify column names exist before using them
   - Prevents errors from searching non-existent fields

4. **Check Guest Room Status**
   - Query BOTH Airbnb/MisterB&B emails AND calendar_events
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

- Daily priorities and recommendations
- Tasks: `- [ ] Task description` or `1. **Task name** (time)`
- Track completed: `- [x]` or ✓
- Collapse outdated sections with `<details><summary>` tags
- **REQUIRED TEMPLATES:**
  - Morning: Insert `vault/templates/morning-routine.md` after day's focus
  - Evening: Insert `vault/templates/evening-routine.md` before evening tasks

### Incremental Updates (Performance)

For existing reviews:
- Query only recent changes (compare timestamps)
- Focus on: new emails, modified tasks, updated events, new notes
- Append updates with timestamp: `### Update (2:30 PM)`

### Available Commands

```bash
# Task management
bin/tasks sync                         # Sync all tasks and projects
bin/tasks list --today                 # Show today's tasks  
bin/tasks add "New task" --date 2025-08-14 --priority 4
bin/tasks done <id>                    # Mark task as complete
bin/tasks projects --detailed          # Show detailed project info

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

`vault/tasks/streaks-today.md` - daily habits for long-term health goals.

### Hosting

Two guest rooms via Airbnb/MisterB&B:
- Check-out: 12 PM (clean after)
- Check-in: 3 PM (prep before)

### Contact Tracking

6-week follow-up system for close friends:
- Query: `SELECT * FROM contacts WHERE julianday('now') - julianday(last_contacted) > 42`
- Update: `UPDATE contacts SET last_contacted = DATE('now') WHERE full_name = 'Name'`
- Great "Off Stage" activity for Tue/Fri

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

- **task_cache**: Tasks with stages, due dates, categories
- **emails**: Received (iCloud) and sent (Pobox via `bin/pobox-sync`)
- **calendar_events**: Events with timezone data
- **contacts**: Contact info with normalized data
- **diary**: Day One journal entries from `vault/logs/Journal.json`
- **file_tracking**: Recently modified files
- **notion_pages**: Notes and projects
- **toggl_***: Time tracking data

### OGM Monitoring

- **ogm_github_issues**: Bugs and features
- **ogm_honeybadger_faults**: Production errors
- **ogm_scout_metrics**: Performance data
- **ogm_summary_stats**: Daily aggregates

<details>
<summary>
### Essential SQL Queries
</summary>

```sql
-- Urgent tasks
SELECT title, stage, due_date, category 
FROM task_cache 
WHERE stage IN ('🔥 Immediate', '🚀 1st Priority') 
   OR due_date <= DATE('now', '+1 day')
ORDER BY due_date;

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

-- OGM critical errors
SELECT klass, notices_count, last_notice_at
FROM ogm_honeybadger_faults 
WHERE resolved = 0 AND notices_count > 1000
ORDER BY notices_count DESC;

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

```bash
# Critical tasks
bin/tasks add "Task title" --date YYYY-MM-DD --status "🔥 Immediate"

# High priority
bin/tasks add "Task title" --date YYYY-MM-DD --status "🚀 1st Priority"

# Then sync
bin/tasks sync
```

Copy task WITH ID (`<!-- task-id: xxx -->`) from today.md to review file.

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

## Your First Steps

1. **Calculate day of week** (see critical steps above)
2. **Get current Eastern time** via bash command
3. **Query database** at `.data/today.db`
4. **Check/create plan file** at `vault/plans/YYYY_QQ_MM_W##_DD.md`
5. **Analyze and recommend** based on data, theme, and goals
6. **Stay engaged** - this is an interactive session

Please query the database and provide specific, actionable recommendations for today.

Let's begin the daily review!
