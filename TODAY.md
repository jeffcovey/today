# Daily Review Session

## How This Works
This file starts an interactive Claude session for your daily review. The `bin/today` script:
1. Checks Claude authentication
2. Syncs all data sources
3. Updates the SUMMARY.json with comprehensive content
4. Starts this interactive session where Claude will:
   - Review all your data
   - Create or update today's review file in `notes/reviews/YYYY-MM-DD.md`
   - Provide recommendations based on your schedule and priorities
   - Continue working with you as long as needed

## Session Instructions for Claude

### Initial Tasks
When this session starts, please:
1. Load and analyze the SUMMARY.json file
2. **CRITICAL: Calculate the day of the week from today's date (DO NOT infer from activities)**
3. Check if a review file exists for today in `notes/reviews/YYYY-MM-DD.md`
4. Create or update the review file with your analysis
5. Present your recommendations to the user

### Review File Format
The review file should include:
- Daily priorities and recommendations
- Tasks formatted with checkboxes: `- [ ] Task description`
- Or numbered format: `1. **Task name** (time estimate)`
- Group tasks by time of day or category
- Track completed tasks with ✓ marks

### Commands Available
The user can use these commands during the session:
```bash
bin/mark-done "Take a 20-minute walk"  # Mark specific task as done
bin/mark-done 1                        # Mark task #1 as done
bin/progress "Additional note"         # Add a progress note
```

## Review Guidelines
Please help me review my current situation and decide what to do today to be happy and productive. All my data sources have been synchronized and the SUMMARY.json contains comprehensive analysis.

**IMPORTANT:** This is an interactive session. You can:
- Take as long as needed to analyze the data
- Create and update files
- Run commands to help with the review
- Continue working with me throughout the day

### Guidelines

#### Schedule

Unless I specify otherwise, I am usually in the Eastern United States (New York) time zone. Use that for calculating times and dates. My home is in Oakland Park, Florida.

I generally wake up around 5:30-6:00AM. It takes me an hour in the morning to stretch, etc. before I start work. I go to bed around 9:30PM, but I like to go offline for the last couple of hours. I should wrap up the day's work and plan tomorrow by mid-evening.

#### Vocation

I’m retired, and would like to remain that way if I can maintain my finances. I devote my life to https://oldergay.men/, a website for older gay men and their admirers. Aside from personal health and wellness, Older Gay Men is my passion and vocation.

#### Streaks

notes/tasks/streaks-today.md contains what remains undone in my Streaks app (https://streaksapp.com). I want to complete these tasks every day. They're long-term habits, and should contribute toward my ongoing goals, like exercise tasks to keep me physically healthy.

#### Hosting

My Airbnb and MisterB&B calendars are for two rooms I rent in my home. If someone is coming, I need to make up the room in time for their arrival at 3PM. If someone is leaving, I need to clean up the room after they're gone at their 12PM check-out time.

#### Stages

**⚠️ IMPORTANT FOR CLAUDE: Always calculate the actual day of the week from the date. Never infer the day from scheduled activities. Events may be scheduled on any day regardless of the theme.**

I like to arrange my days around three themes, "On Stage", "Back Stage", and "Off Stage". The idea is to group together similar tasks. Examples:

  * Front Stage: Chores when I’m “on stage” with other people. Meetings, phone calls, customer support, email replies, etc.
  * Back Stage: Maintenance tasks that other people don’t see. Tidying my physical and digital spaces, paying bills, fixing bugs that aren’t user-facing, etc.
  * Off Stage: Personal time, to get a break and refresh myself before going back to work. Going out, enjoying Nature, seeing friends, catching up personal correspondence, reading a good book, etc.

I try to follow this schedule:

  * Front Stage: Monday, Wednesday, Saturday
  * Back Stage: Thursday, Sunday
  * Off Stage: Tuesday, Friday

**Day of Week Calculation Reminder:**
- Monday = Front Stage
- Tuesday = Off Stage
- Wednesday = Front Stage
- Thursday = Back Stage
- Friday = Off Stage
- Saturday = Front Stage
- Sunday = Back Stage
 
We shouldn't neglect things that *have* to be done today, but **as much as possible, we should PRIORITIZE WORK/PLAY THAT MATCHES THE DAY'S THEME**.
 

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

## Data Sources

The SUMMARY.json file contains all relevant data already extracted from:
- 📝 Local notes (concerns, recent files)
- ✅ Notion databases (tasks categorized by status and category)
- 📧 Email database (recent messages analyzed)
- 🔄 Incremental changes since last review

**First Action:** Read the SUMMARY.json file to get all the synchronized data, then create or update today's review file in `notes/reviews/`.

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

## Your First Steps

1. **Read SUMMARY.json** to get all the synchronized data
2. **Calculate Day of Week** - ALWAYS determine the actual day from the date, never from activities
3. **Check/Create Review File** at `notes/reviews/YYYY-MM-DD.md` with correct day name
4. **Analyze and Recommend** based on:
   - Current concerns from notes
   - Urgent and overdue tasks
   - Important emails needing responses
   - Today's theme (Front/Back/Off Stage) based on the CALCULATED day
   - Daily habits from Streaks
5. **Continue Supporting** - This is an interactive session, stay engaged and help throughout

Please analyze the SUMMARY.json and provide specific, actionable recommendations for today.

Let's begin the daily review!
