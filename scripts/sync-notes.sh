#!/bin/bash

# Simple script to sync notes from GitHub
# Run this to pull latest notes from other devices

echo "📝 Syncing notes from GitHub..."

# Ensure we're in the right directory
cd "$(dirname "$0")/.." || exit

# Pull latest changes
git pull origin main

# Show recent notes
echo ""
echo "📚 Recent notes:"
find notes -type f -name "*.md" -mtime -7 | head -10

echo ""
echo "✅ Notes synced successfully!"