# Notion to Today Migration Guide

This guide documents the tools and workflow for migrating tasks from Notion to the Today system.

## Overview

The migration process allows you to:
1. Import tasks from Notion databases
2. Track which tasks came from Notion
3. Mark tasks as done in Notion after successful migration
4. Clean up Notion references once migration is complete

## Prerequisites

- Notion API token in your `.env` file as `NOTION_TOKEN`
- Notion tasks already imported using `bin/notion`

## Finding Notion-Imported Tasks

### List all tasks with Notion IDs

```bash
bin/tasks list --with-notion
```

This shows all tasks that have Notion IDs attached, making it easy to see what was imported from Notion.

### Combine with other filters

```bash
# Show Notion tasks in Front Stage only
bin/tasks list --with-notion --stage "Front Stage"

# Show Notion tasks in compact format
bin/tasks list --with-notion --compact

# Show today's Notion tasks
bin/tasks list --with-notion --today
```

## Marking Tasks as Done in Notion

The `bin/notion-mark-done` tool marks tasks as completed in Notion after confirming successful migration.

### Interactive Mode

Run without arguments to see available tasks:

```bash
bin/notion-mark-done
```

This displays a numbered list of recent tasks with Notion IDs and their current status.

### Mark a Specific Task

Use partial task ID, Notion ID, or title:

```bash
# Using partial task ID
bin/notion-mark-done 197d00

# Using partial Notion ID
bin/notion-mark-done 2295e778

# Using title search
bin/notion-mark-done "fridge water"
```

### Mark All Tasks

Mark all migrated tasks as done in Notion:

```bash
bin/notion-mark-done --all
```

### Dry Run Mode

Preview changes without actually updating Notion:

```bash
# Single task
bin/notion-mark-done --dry-run 197d00

# All tasks
bin/notion-mark-done --all --dry-run
```

### Verbose Mode

See detailed information during processing:

```bash
bin/notion-mark-done -v 197d00
```

### What It Does

When marking a task as done in Notion, the tool:
- Sets the **Status** property to "✅ Done" (using Notion's status type)
- Clears the **Repeat Every (Days)** property to prevent task recreation
- Adds a small delay between updates to avoid rate limiting

Note: The Status property in Notion uses the `status` type, not `select`. The tool handles this correctly.

## Cleaning Up After Migration

Once you've confirmed all tasks are properly migrated and marked as done in Notion, remove the Notion IDs from your local database:

### Check for Notion IDs

```bash
# See how many tasks have Notion IDs
bin/tasks clear-notion-ids
```

### Remove Notion IDs

```bash
# Requires --force flag for safety
bin/tasks clear-notion-ids --force
```

⚠️ **Warning**: This action cannot be undone. Make sure you've marked all tasks as done in Notion first.

## Complete Migration Workflow

1. **Import tasks from Notion**
   ```bash
   bin/notion
   ```

2. **Review imported tasks**
   ```bash
   bin/tasks list --with-notion
   ```

3. **Test with dry run**
   ```bash
   bin/notion-mark-done --dry-run 197d00
   ```

4. **Mark individual tasks as done**
   ```bash
   bin/notion-mark-done 197d00
   ```

5. **Or mark all tasks as done**
   ```bash
   bin/notion-mark-done --all
   ```

6. **Clean up Notion IDs**
   ```bash
   bin/tasks clear-notion-ids --force
   ```

## Troubleshooting

### NOTION_TOKEN not found

If you get an error about missing NOTION_TOKEN:
1. Check your `.env` file has `NOTION_TOKEN=your-token-here`
2. Ensure dotenvx is installed: `npm install dotenvx`
3. The token should start with `secret_`

### Task not found

If a task isn't found:
- Use `bin/tasks list --with-notion` to see exact IDs
- Try a longer partial ID to avoid ambiguity
- Search by title if ID doesn't work

### Rate limiting

If updating many tasks:
- The tool automatically adds delays between updates
- For large batches, consider updating in smaller groups
- Use `--dry-run` first to verify the list

### Notion update fails

If a task fails to update in Notion:
- Check the task still exists in Notion
- Verify your Notion token has write permissions
- Ensure the database has Status and "Repeat Every (Days)" properties
- Use `-v` flag for detailed error messages

## Database Schema

Tasks imported from Notion have these additional fields:
- `notion_id`: The Notion page ID
- `notion_url`: The Notion page URL (if available)

These fields are cleared when you run `bin/tasks clear-notion-ids --force`.

## Safety Features

- **Dry run mode**: Preview changes before making them
- **Confirmation prompts**: Destructive operations require explicit confirmation
- **Partial ID matching**: Use short IDs for convenience
- **Rate limit protection**: Automatic delays between API calls
- **Verbose logging**: Detailed output for debugging