#!/bin/bash
# Setup Turso authentication in the container
# This script should be run during container build or startup

# Method 1: Using environment variable (recommended for CI/CD)
# The TURSO_API_TOKEN environment variable can be used by the Turso CLI
# Add this to your .env file (DO NOT commit to git):
# TURSO_API_TOKEN=your_token_here

# Method 2: Pre-configure the settings file
# This creates the Turso config directory and settings file
setup_turso_config() {
    local TOKEN="$1"
    local USERNAME="$2"
    
    if [ -z "$TOKEN" ] || [ -z "$USERNAME" ]; then
        echo "Usage: setup_turso_config <token> <username>"
        return 1
    fi
    
    # Create config directory
    mkdir -p ~/.config/turso
    
    # Create settings.json with the token
    cat > ~/.config/turso/settings.json << EOF
{
  "config": {
    "last_update_check": $(date +%s)
  },
  "config-path": "",
  "token": "$TOKEN",
  "username": "$USERNAME"
}
EOF
    
    echo "Turso configuration created at ~/.config/turso/settings.json"
}

# Method 3: Create a wrapper for xdg-open to handle browser auth in containers
setup_browser_wrapper() {
    # Create a simple xdg-open wrapper that prints the URL
    cat > /usr/local/bin/xdg-open << 'EOF'
#!/bin/bash
echo "Browser requested to open: $1"
echo "Please visit this URL manually to authenticate"
EOF
    chmod +x /usr/local/bin/xdg-open
    echo "Browser wrapper installed at /usr/local/bin/xdg-open"
}

# Check if we have the token in environment
if [ -n "$TURSO_API_TOKEN" ]; then
    echo "TURSO_API_TOKEN found in environment"
    # Optionally set up the config file too
    if [ -n "$TURSO_USERNAME" ]; then
        setup_turso_config "$TURSO_API_TOKEN" "$TURSO_USERNAME"
    fi
elif [ -n "$1" ] && [ -n "$2" ]; then
    # If token and username provided as arguments
    setup_turso_config "$1" "$2"
else
    echo "To set up Turso authentication, either:"
    echo "1. Set TURSO_API_TOKEN environment variable"
    echo "2. Run: $0 <token> <username>"
    echo ""
    echo "To get your token, run: turso auth token"
fi