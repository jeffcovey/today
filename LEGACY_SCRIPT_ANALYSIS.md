# Legacy Script Analysis & Integration Plan

## Overview
The legacy Ruby script (`notion_daily_logging`) is a comprehensive automation system for managing Notion databases with daily operations, task management, calendar generation, and data synchronization. Below is a detailed analysis of its features and a plan for integration into the current Node.js application.

## Features Provided by Legacy Script

### 1. **File Management & Data Processing**
- **JSON File Cleaning**: Automatically cleans and reformats JSON files when they change
- **Deduplication**: Removes duplicate entries from `daily_tracking.txt` 
- **File Modification Tracking**: Tracks modification times of files to avoid unnecessary processing

### 2. **Time & Calendar Management**
- **Task Time Scheduling**: Sets specific times for tasks based on estimates and availability
- **Calendar Generation**: Creates ICS calendar files with:
  - Tasks from Action Items database
  - Plans from Today's Plan database  
  - Now & Then tasks (quick tasks)
  - External calendar integration (Google Calendar)
- **Conflict Resolution**: Handles scheduling conflicts between tasks and blocking events
- **Calendar Upload**: Uploads generated calendar to remote server via SCP

### 3. **Daily Tracking & Logging**
- **Log Processing**: Parses `daily_tracking.txt` for time-stamped entries:
  - Wake times
  - Weight measurements  
  - Wakefulness ratings
  - Morning routine completion
  - Fasting periods (start/end)
  - Bedtime
- **Automatic Day/Week Creation**: Creates missing Day and Week entries in Notion
- **Log Matching**: Matches log entries to specific days and updates properties

### 4. **Task & Routine Management**
- **Repeating Task Reset**: Marks completed repeating tasks as "♻️ Repeating" status
- **Routine Reset**: Unchecks "Done" properties in routine databases:
  - Morning Routine
  - Evening Tasks  
  - Day-End Chores
  - Today's Plan
  - Inboxes
- **Stage Task Scheduling**: Handles special "🎭 Stage" tasks for upcoming week

### 5. **Streaks Tracking**
- **Streaks Page Updates**: Updates a Notion page with streak data from `streaks.txt`
- **File Change Detection**: Only updates when streak file changes (using hash comparison)

### 6. **Time Tracking Integration**
- **Toggl Integration**: Syncs time entries from Toggl to Notion Pillars database
- **Focus.json Processing**: Converts Focus app time entries to Toggl entries
- **Project Mapping**: Maps Toggl projects to Notion pillars for time allocation tracking
- **Duplicate Removal**: Removes duplicate time entries automatically

## Database Dependencies

The legacy script uses these Notion databases that are **NOT** currently accessible in our application:

### **Required Access**:
1. **`days_database_id`** - Daily tracking entries
2. **`weeks_database_id`** - Weekly planning entries  
3. **`todays_plan_database_id`** - Daily planning items
4. **`now_and_then_database_id`** - Quick tasks
5. **`inboxes_database_id`** - Inbox items to process
6. **`pillars_database_id`** - Life areas for time tracking

### **Currently Accessible**:
- `action_items_database_id` - Main tasks (our current tasks database)
- `morning_routine_database_id` - Morning routine items
- `evening_tasks_database_id` - Evening tasks  
- `day_end_chores_database_id` - Day-end chores

## Integration Plan

### **Phase 1: Core Database Access**
1. **Add missing database configurations** to our current config system
2. **Request Notion access** to the 6 missing databases listed above
3. **Add database detection methods** similar to existing routine database methods
4. **Test connectivity** to all required databases

### **Phase 2: Command Line Features (Non-Interactive)**
Add command-line options for automated operations (suitable for Docker/cron):

```bash
# Daily automation commands
notion-cli daily --reset-routines           # Reset routine checkboxes
notion-cli daily --process-logs             # Process daily_tracking.txt
notion-cli daily --create-missing-days      # Create missing day/week entries
notion-cli daily --update-streaks           # Update streaks page
notion-cli daily --mark-repeating-tasks     # Reset completed repeating tasks

# Time tracking commands  
notion-cli time --sync-toggl                # Sync Toggl to Notion pillars
notion-cli time --process-focus             # Process focus.json entries
notion-cli time --generate-calendar         # Generate ICS calendar file

# File management commands
notion-cli files --clean                    # Clean changed JSON files
notion-cli files --deduplicate              # Deduplicate tracking file

# Combined daily run (equivalent to legacy script's default behavior)
notion-cli daily --all
```

### **Phase 3: Interactive Features**
Add interactive options to the main CLI interface:

```
? What would you like to do?
❯ 📁 Sort tasks by project (731 available)
  🏷️ Assign tags to tasks (1132 available) 
  📅 Edit Do Date for tasks (40 available)
  ✏️ Batch edit task properties
  🌅 Complete morning routine (9 remaining)
  🌙 Complete evening tasks (10 remaining)
  🏠 Complete day-end chores (17 remaining)
  📋 Manage today's plan
  ⚡ Quick tasks (now & then)
  📊 View time tracking & streaks
  🔄 Daily automation tools
  🚪 Exit
```

### **Phase 4: Advanced Calendar & Time Features**
1. **Calendar Generation**: 
   - Implement ICS file generation with task scheduling
   - Add conflict resolution for overlapping events
   - Support external calendar integration
2. **Time Tracking**:
   - Toggl API integration for time sync
   - Focus app data processing
   - Pillar-based time allocation tracking

### **Phase 5: File Processing & Automation**
1. **Daily Tracking Parser**: Parse and process `daily_tracking.txt` format
2. **Automated Day/Week Creation**: Create missing temporal entries
3. **File Monitoring**: Track file changes and trigger appropriate actions
4. **Streaks Management**: Update streak tracking pages

## Technical Implementation Notes

### **Architecture Changes Needed**:
1. **Add new database managers** for Days, Weeks, Today's Plan, Now & Then, Inboxes, Pillars
2. **Create time tracking module** for Toggl integration
3. **Add calendar generation module** using a Node.js ICS library
4. **Implement file processing utilities** for log parsing and file monitoring
5. **Add command-line argument parsing** for non-interactive operations

### **Dependencies to Add**:
- `ical-generator` or similar for calendar creation
- `node-cron` for scheduled operations
- `chokidar` for file watching
- `ssh2` for remote file uploads
- Toggl API client library

### **Configuration Extensions**:
- Add missing database IDs to environment/config
- Add Toggl API credentials
- Add remote server details for calendar uploads
- Add file paths for tracking files

## Current Status & Next Steps

### **Immediate Actions Required**:
1. ✅ **Database Access**: Request access to the 6 missing Notion databases
2. ✅ **Config Update**: Add missing database IDs to configuration
3. ✅ **Basic Commands**: Implement daily routine reset functionality
4. ✅ **Testing**: Verify current database access is working correctly

### **Broken/Missing Features to Address**:
- **Daily tracking entries**: Currently broken, needs database access
- **Calendar generation**: Not implemented
- **Time tracking sync**: Requires Toggl integration  
- **Automated day/week creation**: Needs Days/Weeks database access

The legacy script provides significant automation value, particularly for daily routines and time tracking. Integrating these features will make the current CLI much more powerful for daily productivity management.