# Container Setup Issues - RESOLVED

## Summary
Both issues have been resolved:
1. ✅ `claude` CLI will be available when the container starts (after rebuild)
2. ✅ `bin/tunnel` now works to create VS Code tunnels

## Issues and Solutions

### 1. Claude CLI Installation
- **Problem**: `claude` command not found when container starts
- **Solution Applied**: Added `npm install -g @anthropic-ai/claude-code` to postCreateCommand in `.devcontainer/devcontainer.json`
- **Status**: Should work after container rebuild

### 2. VS Code Tunnel Script
- **Problem**: Running `bin/tunnel` opens the file for editing instead of executing it
- **Root Cause**: In devcontainer environments, the `code` command is the VS Code remote CLI which opens files by default
- **Solution Applied**: Modified `bin/tunnel` to download and use standalone VS Code CLI
- **Status**: FIXED - The script now:
  - Downloads VS Code CLI on first run to `.vscode-cli/` directory
  - Uses the standalone CLI which supports tunnel functionality
  - Added `.vscode-cli/` to `.gitignore`

## Current Solutions

### Claude CLI Installation
- **Solution**: Added `npm install -g @anthropic-ai/claude-code` to postCreateCommand in `.devcontainer/devcontainer.json`
- **Status**: Will work after container rebuild

### VS Code Tunnel Script
- **Solution**: Modified `bin/tunnel` to download and use standalone VS Code CLI
- **How it works**:
  1. Checks if `.vscode-cli/code` exists
  2. If not, downloads the standalone VS Code CLI
  3. Runs tunnel command using the standalone CLI
- **Status**: Ready to use

### Current File Contents

**`.devcontainer/devcontainer.json`**:
- Uses Microsoft's pre-built Node.js 20 image
- postCreateCommand: `"npm install && npm install -g @anthropic-ai/claude-code"`
- Does NOT use the custom Dockerfile

**`bin/tunnel`**:
- Downloads standalone VS Code CLI to `.vscode-cli/` on first run
- Executes tunnel command using `/workspaces/notion-cli/.vscode-cli/code tunnel`

## Important Note
The Dockerfile in the root directory is NOT being used by VS Code devcontainers. The devcontainer uses the configuration in `.devcontainer/devcontainer.json` instead.