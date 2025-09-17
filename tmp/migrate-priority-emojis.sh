#!/bin/bash

# Priority mapping based on the migration plan:
# 1️⃣ 1st Priority → ⏫ (High)
# 2️⃣ 2nd Priority → 🔼 (Medium)
# 3️⃣ 3rd Priority → (none) (Normal)
# Next Up → (none) (Normal)
# 🗂️ To File → (none) (Normal)
# ⏸️ Paused → Tag #paused
# 🤔 Waiting → Tag #waiting

echo "Fetching open tasks with priorities from database..."

# Get all open tasks with their status
sqlite3 .data/today.db "SELECT id, title, status FROM tasks WHERE status != '✅ Done'" > /tmp/priority_tasks.txt

total_tasks=$(wc -l < /tmp/priority_tasks.txt)
echo "Found $total_tasks open tasks"

high_priority=0
medium_priority=0
normal_priority=0
paused_tasks=0
waiting_tasks=0
not_found=0
already_has_priority=0

# Process each task
while IFS='|' read -r task_id title status; do
    # Skip empty lines
    [ -z "$task_id" ] && continue

    # Determine priority emoji based on status
    priority_emoji=""
    tag=""

    case "$status" in
        "1️⃣  1st Priority")
            priority_emoji="⏫"
            priority_type="high"
            ;;
        "2️⃣  2nd Priority")
            priority_emoji="🔼"
            priority_type="medium"
            ;;
        "3️⃣  3rd Priority"|"Next Up"|"🗂️ To File")
            priority_emoji=""
            priority_type="normal"
            ;;
        "⏸️  Paused")
            tag="#paused"
            priority_type="paused"
            ;;
        "🤔 Waiting")
            tag="#waiting"
            priority_type="waiting"
            ;;
        *)
            priority_emoji=""
            priority_type="unknown"
            ;;
    esac

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

        # Check if task is open (not completed)
        if echo "$line_content" | grep -q "^- \[ \]"; then
            # Check if it already has a priority emoji
            if echo "$line_content" | grep -q "[⏫🔼🔽⏬🔺]"; then
                already_has_priority=$((already_has_priority + 1))
            else
                # Add priority emoji or tag
                escaped_id=$(echo "$task_id" | sed 's/[[\.*^$()+?{|]/\\&/g')

                if [ -n "$priority_emoji" ]; then
                    # Add priority emoji after the task text, before the HTML comment
                    sed -i "s/^\(- \[ \] .*\)\( <!-- task-id: $escaped_id.*\)$/\1 $priority_emoji\2/" "$file_path"

                    case "$priority_type" in
                        "high")
                            high_priority=$((high_priority + 1))
                            echo "⏫ High: ${title:0:50}..."
                            ;;
                        "medium")
                            medium_priority=$((medium_priority + 1))
                            echo "🔼 Medium: ${title:0:50}..."
                            ;;
                    esac
                elif [ -n "$tag" ]; then
                    # Add tag for paused/waiting tasks
                    sed -i "s/^\(- \[ \] .*\)\( <!-- task-id: $escaped_id.*\)$/\1 $tag\2/" "$file_path"

                    case "$priority_type" in
                        "paused")
                            paused_tasks=$((paused_tasks + 1))
                            echo "#paused: ${title:0:50}..."
                            ;;
                        "waiting")
                            waiting_tasks=$((waiting_tasks + 1))
                            echo "#waiting: ${title:0:50}..."
                            ;;
                    esac
                else
                    # Normal priority - no emoji needed
                    normal_priority=$((normal_priority + 1))
                fi
            fi
        fi
    else
        not_found=$((not_found + 1))
    fi

    # Progress indicator
    processed=$((high_priority + medium_priority + normal_priority + paused_tasks + waiting_tasks + already_has_priority + not_found))
    if [ $((processed % 100)) -eq 0 ]; then
        echo "Progress: $processed/$total_tasks tasks processed..."
    fi

done < /tmp/priority_tasks.txt

echo ""
echo "=== Migration Summary ==="
echo "Total open tasks: $total_tasks"
echo "Added high priority ⏫: $high_priority"
echo "Added medium priority 🔼: $medium_priority"
echo "Normal priority (no emoji): $normal_priority"
echo "Added #paused tag: $paused_tasks"
echo "Added #waiting tag: $waiting_tasks"
echo "Already had priority: $already_has_priority"
echo "Not found in markdown: $not_found"