#!/bin/bash

# Get all completed tasks from database with their IDs and completion dates
echo "Fetching completed tasks from database..."

sqlite3 .data/today.db "SELECT id, title, completed_at FROM tasks WHERE status = '✅ Done'" > /tmp/completed_tasks.txt

total_tasks=$(wc -l < /tmp/completed_tasks.txt)
echo "Found $total_tasks completed tasks"

updated=0
already_complete=0
not_found=0

# Process each completed task
while IFS='|' read -r task_id title completed_at; do
    # Skip empty lines
    [ -z "$task_id" ] && continue

    # Format the completion date
    if [ -n "$completed_at" ]; then
        # Extract just the date part (YYYY-MM-DD) from datetime
        completion_date=$(echo "$completed_at" | cut -d' ' -f1)
    else
        # Use today's date if no completion date
        completion_date=$(date +%Y-%m-%d)
    fi

    # Search for this task in markdown files
    result=$(grep -r "task-id: $task_id" vault/ \
        --include="*.md" \
        --exclude-dir="plans" \
        --exclude-dir="Apple Notes" \
        --exclude-dir="Bear" \
        --exclude-dir="@file" \
        --exclude-dir="@inbox" \
        --exclude-dir="@templates" \
        --exclude-dir="@tmp" \
        --exclude-dir=".sync" \
        --exclude-dir=".conflict-backup*" 2>/dev/null | head -1)

    if [ -n "$result" ]; then
        file_path=$(echo "$result" | cut -d: -f1)
        line_content=$(echo "$result" | cut -d: -f2-)

        # Check if task is already marked complete
        if echo "$line_content" | grep -q "^- \[x\]"; then
            already_complete=$((already_complete + 1))
        elif echo "$line_content" | grep -q "^- \[ \]"; then
            # Task needs to be marked complete
            # Create a backup first
            cp "$file_path" "${file_path}.bak"

            # Replace the line: change checkbox and add completion date
            # Escape special characters for sed
            escaped_id=$(echo "$task_id" | sed 's/[[\.*^$()+?{|]/\\&/g')

            # Update the file
            sed -i "s/^- \[ \] \(.*task-id: $escaped_id.*\)$/- [x] \1/" "$file_path"

            # Add completion date if not already present
            if ! grep -q "task-id: $task_id.*✅" "$file_path"; then
                sed -i "s/\(.*task-id: $escaped_id\)\( -->\)/\1\2 ✅ $completion_date/" "$file_path"
            fi

            updated=$((updated + 1))
            echo "✓ Updated: ${title:0:50}..."
        fi
    else
        not_found=$((not_found + 1))
    fi

    # Progress indicator
    processed=$((updated + already_complete + not_found))
    if [ $((processed % 50)) -eq 0 ]; then
        echo "Progress: $processed/$total_tasks tasks processed..."
    fi

done < /tmp/completed_tasks.txt

echo ""
echo "=== Migration Summary ==="
echo "Total completed tasks: $total_tasks"
echo "Updated to complete: $updated"
echo "Already marked complete: $already_complete"
echo "Not found in markdown: $not_found"