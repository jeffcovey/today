# Task Management System

The Today system includes a built-in task management system that syncs between a SQLite database and Markdown files.

## Features

- **Bidirectional sync**: Changes in database or Markdown files propagate both ways
- **Rich metadata**: Tasks support do_date, priority, stage, tags, projects, and repeating schedules
- **Unique IDs**: Each task gets a unique ID to prevent collisions
- **Auto-generated views**: Daily task lists are generated automatically

## Database Schema

Tasks are stored in `.data/today.db` with the following structure:

- `tasks`: Core task data (title, description, dates, stage, priority)
- `projects`: Project definitions
- `tags`: Tag definitions
- `task_tags`: Many-to-many relationship between tasks and tags
- `markdown_sync`: Tracks which tasks appear in which files

## Task Stages

- `inbox`: New tasks that need processing
- `next`: Tasks to do soon
- `active`: Currently working on
- `waiting`: Blocked or waiting for something
- `done`: Completed tasks
- `archived`: Old completed tasks

## Markdown Format

Tasks in Markdown files include an HTML comment with their ID:

```markdown
- [x] Task title here <!-- task-id: unique-id-here --> <!-- task-id: b9cd59bfbd573c20e6b9581609ef6ab5 -->
- [x] Completed task <!-- task-id: another-unique-id --> <!-- task-id: 88602ad8021a39a4b7333171c9b1e432 -->
```

## CLI Commands

### Sync tasks

```bash
bin/tasks sync [file]  # Sync all or specific file
```

### List tasks

```bash
bin/tasks list         # List all active tasks
bin/tasks list --today # Show today's tasks
bin/tasks list --stage inbox  # Filter by stage
```

### Add tasks

```bash
bin/tasks add "Task title" --date 2025-08-14 --priority 4 --tags "work,urgent"
```

### Update tasks

```bash
bin/tasks update <id> --title "New title" --stage active
```

### Mark as done

```bash
bin/tasks done <id>
```

### View projects

```bash
bin/tasks projects
```

## Integration with bin/sync

The task sync is automatically run when you execute `bin/sync`. It will:

1. Sync all markdown files in `vault/tasks/` and `vault/projects/`
2. Add IDs to new tasks
3. Update task states based on checkboxes
4. Generate `vault/tasks-today.md` with tasks due today
5. Process repeating tasks

## Files Synced

- `vault/tasks/tasks.md` - General task list
- `vault/tasks-today.md` - Auto-generated daily tasks
- `vault/tasks/streaks-today.md` - Streak tracking
- `vault/projects/*.md` - Project-specific tasks

## Notion Integration

While the task system is separate from Notion, you can still:
- Import tasks from Notion's Action Items database
- Export tasks to Notion if needed
- Keep both systems in parallel during migration
