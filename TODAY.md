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
bin/today  # Syncs, generates summary, sends to Claude, and saves to notes/reviews/
```

**Review Notes:** Each run of `bin/today` automatically saves Claude's analysis to `notes/reviews/YYYY-MM-DD.md`. Run multiple times during the day to track progress - subsequent runs append updates with timestamps.

## Instructions
Please help me review my current situation and decide what to do today to be happy and productive. All my data sources have been synchronized and analyzed.

### Guidelines

I generally wake up around 5:30-6:00AM. It takes me an hour in the morning to stretch, etc. before I start work. I go to bed around 9:30PM, but I like to go offline for the last couple of hours. I should wrap up the day's work and plan tomorrow by mid-evening.

notes/tasks/streaks-today.md contains what remains undone in my Streaks app (https://streaksapp.com). I want to complete these tasks every day. They're long-term habits, and should contribute toward my ongoing goals, like exercise tasks to keep me physically healthy.

My Airbnb and MisterB&B calendars are for two rooms I rent in my home. If someone is coming, I need to make up the room in time for their arrival at 3PM. If someone is leaving, I need to clean up the room after they're gone at their 12PM check-out time.

### Data Inputs

**IMPORTANT: All data has already been extracted and analyzed in the SUMMARY.json below. DO NOT query databases or files directly - everything you need is in the summary:**

The SUMMARY.json contains:
- **content.concerns**: My current worries and issues from notes
- **content.urgent_tasks**: Tasks due today/tomorrow with titles
- **content.overdue_tasks**: Tasks past their due date
- **content.task_categories**: Breakdown of tasks by category
- **content.important_emails**: Emails needing attention
- **content.people_to_contact**: People mentioned in notes as needing contact
- **changes**: New/modified items since last review
- **recommendations.daily_focus**: Time-based suggestions

Please use ONLY the summary data below to provide your analysis. Focus on:
1. Address the concerns listed
2. Prioritize the urgent/overdue tasks
3. Suggest which emails need responses
4. Recommend a schedule for today

## Data Already Extracted in Summary Below

The SUMMARY.json below contains all relevant data already extracted from:
- 📝 Local notes (concerns, recent files)
- ✅ Notion databases (442 tasks categorized)  
- 📧 Email database (recent messages analyzed)
- 🔄 Incremental changes since last review

**DO NOT attempt to query these sources directly. Use only the SUMMARY.json data provided below.**

## What I Need From You

Based on the SUMMARY.json data below, please provide:

### 1. Current Status Assessment
- What looks most urgent based on the summary data?
- What patterns do you see in the content?
- What might be falling through the cracks?

### 2. Today's Top 3-5 Priorities
Based on the summary's urgent_tasks, overdue_tasks, and concerns

### 3. Quick Wins (under 15 minutes)
From the tasks and emails in the summary

### 4. Deep Work Recommendation (1-2 hours)
What complex work needs focused attention?

### 5. Communications to Address
Based on important_emails and people_to_contact in the summary

### 6. Evening Planning
What to review and prepare based on the data

### 7. Self-Care Check
Address any wellbeing concerns from the summary

---

Please analyze the SUMMARY.json below and provide specific, actionable recommendations for today.