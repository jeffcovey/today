#!/bin/bash
# Setup local mounts/symlinks from mounts.local configuration
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MOUNTS_FILE="$SCRIPT_DIR/mounts.local"
GIT_EXCLUDE="$PROJECT_ROOT/.git/info/exclude"

if [ ! -f "$MOUNTS_FILE" ]; then
    echo "ℹ️  No mounts.local found - skipping local mounts"
    echo "   Copy mounts.local.example to mounts.local to configure"
    exit 0
fi

echo "📁 Setting up local mounts from mounts.local..."

# Ensure .git/info directory exists
mkdir -p "$PROJECT_ROOT/.git/info"

# Collect targets for git exclude
targets=()

while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    [[ "$line" =~ ^#.*$ ]] && continue
    [[ -z "$line" ]] && continue

    # Parse target=source
    target="${line%%=*}"
    source="${line#*=}"

    # Trim whitespace
    target="$(echo "$target" | xargs)"
    source="$(echo "$source" | xargs)"

    [ -z "$target" ] || [ -z "$source" ] && continue

    targets+=("$target")
    target_path="$PROJECT_ROOT/$target"

    # Skip if target is a non-empty directory (e.g., on deployed servers)
    if [ -d "$target_path" ] && [ ! -L "$target_path" ] && [ -n "$(ls -A "$target_path" 2>/dev/null)" ]; then
        echo "   ⏭️  $target: directory exists, skipping"
        continue
    fi

    # Remove existing symlink or empty directory
    if [ -L "$target_path" ]; then
        rm "$target_path"
    elif [ -d "$target_path" ]; then
        rmdir "$target_path"
    fi

    # Create symlink if source exists
    if [ -e "$source" ]; then
        ln -sf "$source" "$target_path"
        echo "   ✅ $target -> $source"
    else
        echo "   ⚠️  $target: source not found: $source"
        # Create empty directory as fallback
        mkdir -p "$target_path"
    fi
done < "$MOUNTS_FILE"

# Update .git/info/exclude with mount targets
if [ ${#targets[@]} -gt 0 ]; then
    # Remove old auto-generated section if exists
    if [ -f "$GIT_EXCLUDE" ]; then
        sed -i '/^# Auto-generated from mounts.local/,/^# End mounts.local/d' "$GIT_EXCLUDE"
    fi

    # Add new section
    {
        echo "# Auto-generated from mounts.local"
        for t in "${targets[@]}"; do
            echo "$t/"
            echo "$t"
        done
        echo "# End mounts.local"
    } >> "$GIT_EXCLUDE"

    echo "   📝 Updated .git/info/exclude with ${#targets[@]} entries"

    # Write .local-mounts.json for jest and other tools to read
    LOCAL_MOUNTS_JSON="$PROJECT_ROOT/.local-mounts.json"
    printf '%s\n' "${targets[@]}" | jq -R . | jq -s '{targets: .}' > "$LOCAL_MOUNTS_JSON"
    echo "   📝 Updated .local-mounts.json"
fi

echo "📁 Mount setup complete"
