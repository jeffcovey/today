#!/bin/bash
# Generate docker-compose.override.yml files from mounts.local.
# Runs on the HOST before container build (via initializeCommand).
#
# Produces TWO override files:
#
# 1. .devcontainer/docker-compose.override.yml — extra bind mounts for the
#    devcontainer itself, so you can edit your real vault / other project
#    directories from inside the devcontainer at /workspaces/today/<name>.
#
# 2. docker-compose.override.yml (at the project root) — bind mount for the
#    `vault` entry (only), applied to the today / scheduler / vault-web /
#    vault-watcher / inbox-api services so that `bin/deploy <local-name>`
#    runs them against your REAL vault instead of whatever is at
#    ./vault on the host project path. Compose auto-merges this with the
#    root docker-compose.yml.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MOUNTS_FILE="$SCRIPT_DIR/mounts.local"
OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.override.yml"
ROOT_OVERRIDE_FILE="$PROJECT_ROOT/docker-compose.override.yml"

if [ ! -f "$MOUNTS_FILE" ]; then
    echo "No mounts.local found - generating empty override"
    cat > "$OVERRIDE_FILE" << 'EMPTY'
# Auto-generated - no mounts.local found
services: {}
EMPTY
    rm -f "$ROOT_OVERRIDE_FILE"
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

# Find the vault mount (if any) and generate the root-level override so the
# Mac local-deployment compose services (scheduler, vault-web, etc.) bind the
# same real vault directory as the devcontainer instead of whatever is at
# ./vault on the project path.
VAULT_SRC=""
while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^#.*$ ]] && continue
    [[ -z "$line" ]] && continue
    target="${line%%=*}"
    source="${line#*=}"
    target="$(echo "$target" | xargs)"
    source="$(echo "$source" | xargs)"
    if [ "$target" = "vault" ] && [ -e "$source" ]; then
        VAULT_SRC="$source"
        break
    fi
done < "$MOUNTS_FILE"

if [ -n "$VAULT_SRC" ]; then
    cat > "$ROOT_OVERRIDE_FILE" << EOF
# Auto-generated from .devcontainer/mounts.local - do not edit manually.
#
# Overrides the vault bind mount for services that need vault access so they
# point at the real host vault directory (from mounts.local) instead of
# whatever the root docker-compose.yml would resolve ./vault to. Without this
# override, bin/deploy <local-name> would run against a stale or empty
# ./vault directory on the host filesystem.
services:
  today:
    volumes:
      - "$VAULT_SRC:/app/vault:cached"
  scheduler:
    volumes:
      - "$VAULT_SRC:/app/vault:cached"
  vault-web:
    volumes:
      - "$VAULT_SRC:/app/vault:cached"
  vault-watcher:
    volumes:
      - "$VAULT_SRC:/app/vault:cached"
  inbox-api:
    volumes:
      - "$VAULT_SRC:/app/vault:cached"
  unison-sync:
    volumes:
      - "$VAULT_SRC:/app/vault:cached"
EOF
    echo "Root override file generated: $ROOT_OVERRIDE_FILE (vault -> $VAULT_SRC)"
else
    # No vault mount configured in mounts.local — remove any stale root
    # override so compose falls back to the default ./vault behavior.
    rm -f "$ROOT_OVERRIDE_FILE"
fi

# Also generate .git/info/exclude to ignore mounted directories
# Use leading slashes so only top-level directories are ignored (not plugin subdirs)
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
