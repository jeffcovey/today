#!/bin/bash
# Common dotenvx loader for all shell scripts
# Source this file to auto-use dotenvx if available

# Function to check if dotenvx encryption is present
has_dotenvx_encryption() {
    [ -f .env.vault ] || grep -q "DOTENV_PUBLIC_KEY" .env 2>/dev/null
}

# Function to check if dotenvx is installed
has_dotenvx_installed() {
    [ -f node_modules/@dotenvx/dotenvx/src/cli/dotenvx.js ]
}

# Auto-execute with dotenvx if available
# Call this at the start of any script that needs env vars
auto_dotenvx() {
    # Skip if already running under dotenvx (prevent infinite loop)
    if [ -n "$DOTENVX_RUNNING" ]; then
        return 0
    fi
    
    if has_dotenvx_encryption && has_dotenvx_installed; then
        # Re-execute the current script with dotenvx
        DOTENVX_RUNNING=1 exec npx dotenvx run --quiet -- "$0" "$@"
    fi
}

# Export functions for use in scripts that source this file
export -f has_dotenvx_encryption
export -f has_dotenvx_installed
export -f auto_dotenvx