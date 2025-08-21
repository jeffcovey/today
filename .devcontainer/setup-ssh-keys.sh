#!/bin/bash
# Setup SSH keys from encrypted environment variables
# This runs during container initialization

set -e

echo "🔑 Setting up SSH keys from encrypted environment..."

# Check if dotenvx is available and we have encrypted keys
if [ -f node_modules/@dotenvx/dotenvx/src/cli/dotenvx.js ] && [ -n "$DO_DEPLOY_KEY_PRIVATE" ]; then
    # Keys are available from dotenvx
    if [[ "$DO_DEPLOY_KEY_PRIVATE" == "encrypted:"* ]]; then
        echo "⚠️  SSH keys are still encrypted. Run 'npx dotenvx run' to decrypt."
        exit 0
    fi
    
    # Create SSH directory if it doesn't exist
    mkdir -p ~/.ssh
    chmod 700 ~/.ssh
    
    # Write the deployment key (handle multi-line properly)
    printf "%s\n" "$DO_DEPLOY_KEY_PRIVATE" > ~/.ssh/do_deploy_key
    chmod 600 ~/.ssh/do_deploy_key
    
    echo "$DO_DEPLOY_KEY_PUBLIC" > ~/.ssh/do_deploy_key.pub
    chmod 644 ~/.ssh/do_deploy_key.pub
    
    # Add to SSH config for easy use
    cat >> ~/.ssh/config << 'EOF'

# DigitalOcean Deployment
Host do-deploy
    HostName ${DO_DROPLET_IP}
    User root
    IdentityFile ~/.ssh/do_deploy_key
    StrictHostKeyChecking no
EOF
    
    echo "✅ SSH deployment keys configured"
    echo "   Public key to add to DigitalOcean:"
    echo "   $(cat ~/.ssh/do_deploy_key.pub)"
else
    echo "ℹ️  No deployment keys found or dotenvx not available"
fi