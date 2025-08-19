# Database Schema

This directory contains the database schema from the restored Turso database (2025-08-19).

## Current State

The database has evolved significantly from what the code expects. There are 37 tables in production but our sync scripts only handle 7 core tables.

## Core Tables (Used by sync)
- `tasks.sql` - Main task storage with priorities and statuses
- `projects.sql` - Project definitions  
- `tags.sql` - Tag definitions
- `task_tags.sql` - Many-to-many relationship
- `task_completions.sql` - Completion tracking (redundant with tasks.completed_at)
- `markdown_sync.sql` - Tracks task locations in markdown files
- `emails.sql` - Email storage

## Additional Tables (37 total)
The complete schema is in `complete-schema.sql`. Many tables appear to be from:
- Notion integration (cache tables)
- Calendar/contact management
- Summary/insights generation
- Various sync tracking

## Schema Version
- Restored from: 2025-08-19T09:30:00Z (5:30 AM EDT)
- Database: today-db-restored
- Size: ~254 MB

## Important Notes

1. **CHECK Constraint on stage**: The tasks table has a CHECK constraint limiting stage values to 'Front Stage', 'Back Stage', 'Off Stage'. This doesn't affect the status column which stores priorities.

2. **Schema Migrations**: We have a migration system in `/src/migrations.js` but it only tracks 3 migrations. The actual database schema is much more complex.

3. **Sync Compatibility**: Our sync scripts create simplified versions of tables. When pulling from Turso, we get the full data. When creating new local databases, we only create the simplified schema.

## Recovery Information

This schema was captured after recovering from data corruption using Turso's point-in-time recovery:

```bash
turso db create today-db-restored --from-db today-db --timestamp 2025-08-19T09:30:00Z
turso db export today-db-restored
```

The recovery restored:
- All priority statuses (🔥 Immediate, 🚀 1st Priority, etc.)
- Most completion dates (some from early morning were affected)
- All 37 tables and their relationships