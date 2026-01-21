#!/bin/bash
# Generate docker-compose.override.yml from mounts.local
# Runs on the HOST before container build (via initializeCommand)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOUNTS_FILE="$SCRIPT_DIR/mounts.local"
OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.override.yml"

if [ ! -f "$MOUNTS_FILE" ]; then
    echo "No mounts.local found - skipping override generation"
    rm -f "$OVERRIDE_FILE"
    exit 0
fi

echo "Generating docker-compose.override.yml from mounts.local..."

# Start the override file
cat > "$OVERRIDE_FILE" << 'HEADER'
# Auto-generated from mounts.local - do not edit manually
services:
  devcontainer:
    volumes:
HEADER

# Parse mounts.local and add volume entries
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

    # Check if source exists on host
    if [ -e "$source" ]; then
        echo "      - \"$source:/workspaces/today/$target:cached\"" >> "$OVERRIDE_FILE"
        echo "  ✅ $target -> $source"
    else
        echo "  ⚠️  $target: source not found: $source"
    fi
done < "$MOUNTS_FILE"

echo "Override file generated: $OVERRIDE_FILE"

# Also generate .git/info/exclude to ignore mounted directories
# Use leading slashes so only top-level directories are ignored (not plugin subdirs)
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXCLUDE_FILE="$PROJECT_ROOT/.git/info/exclude"

if [ -d "$PROJECT_ROOT/.git/info" ]; then
    echo "Generating .git/info/exclude..."

    # Preserve the standard header
    cat > "$EXCLUDE_FILE" << 'HEADER'
# git ls-files --others --exclude-from=.git/info/exclude
# Lines that start with '#' are comments.
# For a project mostly in C, the following would be a good set of
# exclude patterns (uncomment them if you want to use them):
# *.[oa]
# *~
# Auto-generated from mounts.local
HEADER

    # Add mounted directories with leading slash (root-only matching)
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^#.*$ ]] && continue
        [[ -z "$line" ]] && continue

        target="${line%%=*}"
        target="$(echo "$target" | xargs)"
        [ -z "$target" ] && continue

        # Add with leading slash so it only matches at project root
        echo "/$target/" >> "$EXCLUDE_FILE"
        echo "/$target" >> "$EXCLUDE_FILE"
    done < "$MOUNTS_FILE"

    echo "# End mounts.local" >> "$EXCLUDE_FILE"
    echo "  ✅ Git exclude file updated"
fi
