# Daily Review Request

## Prerequisites
First run `bin/sync` to update all data sources, then pipe this file to Claude:
```bash
bin/sync
bin/update-summary  # Updates comprehensive summary with content
cat TODAY.md | claude
```

Or use the shortcut that does everything:
```bash
bin/today  # Syncs, generates summary, and sends to Claude
```

## Instructions
Please help me review my current situation and decide what to do today to be happy and productive. All my data sources have been synchronized.

**Summary Available:** `SUMMARY.json` contains a comprehensive summary with:
- Actual content: task titles, email subjects, note excerpts, concerns
- Incremental tracking: new/modified/deleted items since last review
- AI-ready insights: urgent tasks, overdue items, people to contact
- Time-based recommendations: contextual suggestions based on time of day

**Important:** Use simple, direct commands to access data. Avoid complex node scripts or Task tools. Use commands like:
- `sqlite3 .notion-cache/notion-cache.db "SELECT * FROM task_cache WHERE ..."`
- `find notes -type f -name "*.md" -mtime -7`
- `bin/email list --limit 20`
- `head -20 notes/daily/*.md`

## Available Data Sources

### 📝 Local Notes
- Location: `notes/` directory
- Recent notes from the last 7 days
- Daily notes, task notes, concerns

### ✅ Notion Databases
- Action Items - tasks with stages, due dates, tags
- Morning Routine, Evening Tasks, Day-End Chores
- Today's Plan, Now and Then (quick tasks)
- Inboxes (items to process)
- Days, Weeks, Months tracking

### 📧 Email Database
- Location: `.notion-cache/notion-cache.db` (emails table)
- Last 7 days of emails downloaded
- 4000+ emails in database
- Access with: `bin/email list --limit 20` or `sqlite3 .notion-cache/notion-cache.db "SELECT subject, from_address, date FROM emails ORDER BY date DESC LIMIT 20"`

### 💾 SQLite Database Schema
Tables in `.notion-cache/notion-cache.db`:
- `task_cache` - Notion tasks with title, due_date, stage, tags, description
- `emails` - Email messages with subject, from_address, date, text_content
- `database_cache` - Metadata about Notion databases
- `cache_metadata` - Cache sync timestamps
- `project_pillar_mapping` - Project to pillar relationships

### 🔄 Todoist
- Two-way sync with Notion when configured
- Task management integration

## What I Need From You

**Note:** Please analyze the data directly using the simple commands provided. Don't use complex analysis tools or agents - just query the databases and files directly.

### 1. Current Status Assessment
- What looks most urgent based on the data?
- What patterns do you see?
- What might be falling through the cracks?

### 2. Today's Priorities
Please suggest my top 3-5 priorities for today based on:
- Due dates and deadlines
- Important vs urgent matrix
- Energy and time available
- What would move the needle most

### 3. Quick Wins
- What can I complete in under 15 minutes?
- What would create momentum?
- What would clear mental space?

### 4. Deep Work Recommendation
- What deserves 1-2 hours of focused time?
- What creative or complex work needs attention?

### 5. Communications
- Which emails need responses today?
- What outreach should I make?
- What conversations to prioritize?

### 6. Evening Planning
- What to review at end of day?
- What to prepare for tomorrow?
- What to capture or document?

### 7. Self-Care Check
- What would support my wellbeing today?
- Am I overlooking rest or joy?
- What would make today satisfying?

## Context for Today
[Add any specific context here - meetings, energy level, specific concerns, etc.]

## Specific Questions
[Add any specific questions you want answered]

---

Please analyze my data and provide specific, actionable recommendations for today. Use the actual data from my systems, not generic advice.