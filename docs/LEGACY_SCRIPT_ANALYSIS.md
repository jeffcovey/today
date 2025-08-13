# Legacy Script Analysis & Integration Plan (Updated)

## Overview

The legacy Ruby script (`notion_daily_logging`) is a comprehensive automation system for managing Notion databases with daily operations, task management, and data synchronization. Below is a detailed analysis of its features and a plan for integration into the current Node.js application with SQLite storage.

## Features Provided by Legacy Script

### 1. **Data Management & Processing** ✅ **Updated for SQLite**

- **SQLite Storage**: Migrate all JSON file caching to SQLite database tables
- **Data Synchronization**: Track modification times and sync states in SQLite
- **Cache Management**: Use existing unified caching system for all database operations

### 2. **Time & Calendar Management** ⏸️ **Deferred for Future**

- **Task Time Scheduling**: Sets specific times for tasks based on estimates and availability
- **Calendar Generation**: Creates ICS calendar files *(May revisit later)*
- **External Calendar Integration**: Google Calendar sync *(May revisit later)*
- **Calendar Upload**: Remote deployment *(May revisit later)*

### 3. **Day & Week Management** ✅ **High Priority**

- **Automatic Day/Week Creation**: Creates missing Day and Week entries in Notion with full relationship mapping:
  - Creates Week entries for date ranges (Sunday to Saturday)  
  - Creates Day entries linked to appropriate Week
  - Links each Day to previous Day as "Yesterday" relationship
  - Handles date calculations and prevents duplicates
- **Temporal Data Structure**: Maintains proper hierarchical Day→Week relationships

### 4. **Task & Routine Management** ✅ **Core Feature**

- **Repeating Task Reset**: Marks completed repeating tasks as "♻️ Repeating" status
- **Routine Reset**: Unchecks "Done" properties in routine databases:
  - Morning Routine
  - Evening Tasks  
  - Day-End Chores
  - Today's Plan
  - Inboxes
- **Stage Task Scheduling**: Handles special "🎭 Stage" tasks for upcoming week

### 5. **Streaks Tracking** ✅ **Simplified Implementation**

- **Streaks Page Updates**: Updates a Notion page with streak data
- **SQLite-Based Tracking**: Store streak data and change detection in SQLite instead of file hashes

### 6. **Time Tracking Integration** ✅ **Docker-Ready Redesign**

- **Toggl Integration**: Syncs time entries from Toggl to Notion Pillars database
- **Focus App Processing**: Converts Focus app time entries to Toggl entries
- **Project Mapping**: Maps Toggl projects to Notion pillars for time allocation tracking
- **Duplicate Removal**: Removes duplicate time entries automatically

## Database Dependencies

The legacy script uses these Notion databases that are **NOT** currently accessible in our application:

### **Required Access**

1. **`days_database_id`** - Daily tracking entries
2. **`weeks_database_id`** - Weekly planning entries  
3. **`todays_plan_database_id`** - Daily planning items
4. **`now_and_then_database_id`** - Quick tasks
5. **`inboxes_database_id`** - Inbox items to process
6. **`pillars_database_id`** - Life areas for time tracking

### **Currently Accessible**

- `action_items_database_id` - Main tasks (our current tasks database)
- `morning_routine_database_id` - Morning routine items
- `evening_tasks_database_id` - Evening tasks  
- `day_end_chores_database_id` - Day-end chores

## Integration Plan (Updated for SQLite & Docker)

### **Phase 1: Core Database Access & SQLite Migration** ✅ **In Progress**

1. **Add missing database configurations** to our current config system
2. **Request Notion access** to the 6 missing databases listed above
3. **Add database detection methods** similar to existing routine database methods
4. **Create SQLite tables** for time tracking, streaks, and sync state data
5. **Test connectivity** to all required databases

### **Phase 2: Day/Week Management** ✅ **High Priority**

Implement the sophisticated Day/Week creation system:

```bash
# Day/Week management commands
notion-cli temporal --create-missing-days   # Create missing day/week entries with relationships
notion-cli temporal --sync-weeks           # Sync week data and relationships
```

**Implementation Details:**
- Create Week entries for Sunday-Saturday date ranges
- Create Day entries linked to appropriate Week via relation
- Link each Day to previous Day as "Yesterday" relation
- Handle date calculations and prevent duplicates
- Store temporal data in SQLite for faster lookups

### **Phase 3: Time Tracking & Docker Integration** ✅ **Core Feature**

Redesign file-based processing for Docker environment:

```bash
# Time tracking commands (Docker-ready)
notion-cli time --sync-toggl                # Sync Toggl to Notion pillars
notion-cli time --process-focus             # Process focus app entries via API/database
notion-cli time --update-pillars            # Update time allocation in Notion
```

**Docker-Ready Approach for File Processing:**
1. **Volume Mounts**: Mount focus/time data as Docker volumes
2. **Database Integration**: Store processed entries in SQLite instead of JSON files
3. **API Integration**: Direct API calls instead of file uploads where possible
4. **State Tracking**: Use SQLite to track processed entries instead of file modification times

### **Phase 4: Routine Management & Automation** ✅ **Essential**

Add command-line options for automated operations (suitable for Docker/cron):

```bash
# Daily automation commands
notion-cli daily --reset-routines           # Reset routine checkboxes
notion-cli daily --mark-repeating-tasks     # Reset completed repeating tasks
notion-cli daily --update-streaks           # Update streaks page from SQLite data
notion-cli daily --create-temporal          # Create missing days/weeks
notion-cli daily --all                      # Run all daily automation

# Interactive routine management
notion-cli                                  # Main interactive interface
```

### **Phase 5: Interactive Features**

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

## Technical Implementation Notes (Updated)

### **Architecture Changes Needed**

1. **Add new database managers** for Days, Weeks, Today's Plan, Now & Then, Inboxes, Pillars
2. **Create time tracking module** for Toggl integration using SQLite storage
3. **Extend SQLite schema** for time tracking, streaks, and sync state data
4. **Add temporal management utilities** for Day/Week creation and relationship handling
5. **Add command-line argument parsing** for non-interactive operations

### **SQLite Schema Extensions Needed**

```sql
-- Time tracking and sync state
CREATE TABLE time_entries_sync (
  id TEXT PRIMARY KEY,
  toggl_id TEXT,
  focus_id TEXT,
  processed_at INTEGER,
  pillar_id TEXT,
  duration INTEGER
);

CREATE TABLE streaks_data (
  id TEXT PRIMARY KEY,
  streak_name TEXT,
  current_count INTEGER,
  last_updated TEXT,
  data_hash TEXT
);

CREATE TABLE temporal_sync (
  date TEXT PRIMARY KEY,
  day_id TEXT,
  week_id TEXT,
  created_at INTEGER,
  synced_at INTEGER
);
```

### **Dependencies to Add**

- Toggl API client library (e.g., `toggl-api`)
- `node-cron` for scheduled operations (if needed)
- Focus app integration (API or volume mount processing)

### **Configuration Extensions**

- Add missing database IDs to environment/config
- Add Toggl API credentials
- Add Notion page IDs for streaks tracking
- Add Focus app data source configuration

### **Docker Integration Strategy**

For file-based processing (Focus app, time tracking data):

1. **Volume Mounts**:

   ```yaml
   volumes:
     - ./data/focus:/app/data/focus:ro
     - ./data/time-tracking:/app/data/time-tracking:rw
   ```

2. **API Integration**: Direct Toggl API calls instead of file processing
3. **SQLite State**: Track processing state in database instead of file modification times
4. **Batch Processing**: Process data in batches rather than file-by-file

## Current Status & Next Steps

### **Immediate Actions Required**

1. ✅ **Database Access**: Request access to the 6 missing Notion databases
2. ✅ **Config Update**: Add missing database IDs to configuration  
3. ✅ **SQLite Schema**: Extend schema for time tracking and temporal data
4. ✅ **Day/Week Creation**: Implement sophisticated temporal management
5. ✅ **Testing**: Verify database access and temporal relationship creation

### **Priority Implementation Order**

1. **Day/Week Management** - Critical for productivity workflow
2. **Routine Reset Automation** - Daily automation essential  
3. **Time Tracking Integration** - Toggl sync for accurate time allocation
4. **Streaks Management** - Motivation and tracking
5. **Interactive Interface** - Enhanced CLI options

### **Deferred Features**

- ❌ **Daily tracking log parsing** - No longer using daily_tracking.txt
- ⏸️ **Calendar generation** - Complex feature, may revisit later
- ⏸️ **External calendar integration** - Future enhancement
- ❌ **File-based log matching** - Replaced with direct database operations

The updated plan focuses on the core productivity features while leveraging our existing SQLite infrastructure and preparing for Docker-based automation workflows.
