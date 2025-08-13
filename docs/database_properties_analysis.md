# Notion Database Properties Analysis

## Overview

This analysis examines the properties structure for 6 Notion databases used in the CLI application, identifying their filtering requirements and key properties.

## Database Analysis

### 1. Action Items (394 items)

**Database ID:** `de1740b0-2421-43a1-8bda-f177cec69e11`

**Key Properties:**
- **Done** (`checkbox`): Primary completion indicator
- **Status** (`status`): Complex status with values like "🗂️ To File", "5th Priority", etc.
- **Show Status** (`formula`): Formatted status display
- **Project Status** (`rollup`): Status from related projects

**Date Properties:**
- **Do Date**: Task execution date
- **Start/Repeat Date** (`formula`): Calculated start date for repeating tasks
- **Completion Date**: When task was completed
- **Created At**: Task creation date

**Filtering for Current Items:**

```javascript
// Filter out completed items
items.filter(item => {
  // Check Done checkbox
  if (item.properties?.Done?.checkbox) return false;
  
  // Check Status (exclude "✅ Done")
  const statusProp = item.properties?.Status;
  if (statusProp?.status?.name === '✅ Done') return false;
  
  return true;
});
```

**Other Notable Properties:**
- Projects (DB): Relation to projects
- Tag/Knowledge Vault: Relation to tags
- Stage: Select field for task stage
- Priority: Task priority level
- Minutes Estimate: Time estimate

---

### 2. Morning Routine (9 items)

**Database ID:** `1a177c23-91aa-44a5-b6aa-c1bcb728a537`

**Key Properties:**
- **Done** (`checkbox`): Primary completion indicator
- **Task**: Task name/title
- **Date**: Associated date

**Time-Related Properties:**
- Task Start, Task Due: Task timing
- Routine Start, Routine End: Overall routine timing
- Overdue Minutes, Remaining Minutes: Time tracking

**Filtering for Current Items:**

```javascript
// Simple checkbox filter
items.filter(item => !item.properties?.Done?.checkbox)
```

---

### 3. Today's Plan (12 items)

**Database ID:** `880f6cce-d710-4940-9328-cdbad5c6c259`

**Key Properties:**
- **Done** (`checkbox`): Primary completion indicator
- **Name**: Task name
- **Start/End**: Time block properties
- **Duration**: Task duration

**Filtering for Current Items:**

```javascript
// Simple checkbox filter
items.filter(item => !item.properties?.Done?.checkbox)
```

---

### 4. Evening Tasks (10 items)

**Database ID:** `1fe466a5-f5de-497a-80c5-ca1f19f03dbc`

**Key Properties:**
- **Done** (`checkbox`): Primary completion indicator
- **Task**: Task name
- **Date**: Task date (includes time ranges)
- **Due**: Due time

**Time-Related Properties:**
- Evening Minutes Remaining
- Overdue/Overdue Minutes
- Sunset: Reference time

**Filtering for Current Items:**

```javascript
// Simple checkbox filter
items.filter(item => !item.properties?.Done?.checkbox)
```

---

### 5. Day-End Chores (17 items)

**Database ID:** `b524932a-3ab7-42bd-8a28-6e7cbe0f3e29`

**Key Properties:**
- **Done** (`checkbox`): Primary completion indicator
- **Name**: Chore name
- **Minutes**: Time estimate

**Filtering for Current Items:**

```javascript
// Simple checkbox filter
items.filter(item => !item.properties?.Done?.checkbox)
```

---

### 6. Inboxes (13 items)

**Database ID:** `4083409c-ead3-4544-89e0-b4b3c91c7c80`

**Key Properties:**
- **Done** (`checkbox`): Primary completion indicator
- **Name**: Inbox name
- **URL**: Link to inbox

**Filtering for Current Items:**

```javascript
// Simple checkbox filter
items.filter(item => !item.properties?.Done?.checkbox)
```

---

## Common Patterns

### 1. Completion Tracking

All databases use a **Done** checkbox as the primary completion indicator:
- Property name: "Done"
- Type: `checkbox`
- Filter: `!item.properties?.Done?.checkbox`

### 2. Database-Specific Differences

**Action Items** (most complex):
- Uses both Done checkbox AND Status field
- Has complex status groups ("Complete" group contains "✅ Done")
- Multiple date fields for different purposes
- Rich relationships (projects, tags, people)

**Routine Databases** (Morning, Evening, Day-End):
- Simple Done checkbox only
- Focus on time tracking and sequencing
- Minimal relationships

**Today's Plan**:
- Time-block oriented (Start/End times)
- Duration tracking
- Simple Done checkbox

**Inboxes**:
- URL-focused for external links
- Simple Done checkbox
- Minimal properties

### 3. Date Handling

**Action Items**:
- **Do Date**: Explicit execution date
- **Start/Repeat Date**: Formula-calculated for recurring tasks
- **Completion Date**: Historical tracking

**Routine Databases**:
- **Date**: Single date field, often with time ranges
- Time-specific properties for scheduling

### 4. Current Implementation in CLI

The CLI uses consistent patterns:

1. **Cache-based filtering**: All databases use cached data for performance
2. **Dynamic filtering**: Filters are applied after fetching to ensure accuracy
3. **Simple completion check**: `!item.properties?.Done?.checkbox`
4. **Special handling for Action Items**: Additional Status field checking

## Recommendations

1. **Standardize property names**: Consider using consistent property names across databases (e.g., always "Name" instead of mixing "Name", "Task", "Action Item")

2. **Leverage Status fields**: Only Action Items uses a rich Status field - other databases could benefit from status tracking beyond just Done/Not Done

3. **Date property consistency**: Standardize date property names and types across databases

4. **Performance optimization**: Current approach of fetching all items and filtering client-side works well for small databases but may need optimization for larger ones

5. **Error handling**: Add validation for missing properties to handle database schema changes gracefully
