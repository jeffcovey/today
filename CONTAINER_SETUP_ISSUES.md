# Container Setup Issues - MOSTLY RESOLVED

## Summary
Most issues have been resolved, with one known limitation:
1. ✅ `claude` CLI will be available when the container starts (after rebuild)
2. ✅ `bin/tunnel` downloads correct CLI architecture and works on x64 systems
3. ⚠️ `bin/tunnel` has known ARM64 server limitation (Microsoft VS Code issue)

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

### 3. Architecture Compatibility Issue
- **Problem**: VS Code CLI and server were downloading x64 versions on ARM64 systems, causing Rosetta errors
- **Root Cause**: Script was hardcoded to download `cli-alpine-x64` and VS Code server has limited ARM64 support
- **Solution Applied**: 
  - Added architecture and OS detection to download correct VS Code CLI variant
  - Clear cached x64 servers that were causing conflicts
- **Status**: PARTIALLY FIXED
  - ✅ **CLI Download**: Now correctly downloads ARM64 CLI on ARM64 systems
  - ❌ **Server Component**: VS Code tunnel server still downloads x64 version on ARM64 systems
  - **Limitation**: This appears to be a known issue with VS Code tunnels on ARM64 where the server component doesn't respect the CLI architecture
- **Supported Platforms**:
  - **Linux ARM64**: `cli-alpine-arm64` CLI (server limitation exists)
  - **Linux x64**: `cli-alpine-x64` CLI + `linux-x64` server (fully working)
  - **macOS ARM64**: `cli-darwin-arm64` CLI  
  - **macOS x64**: `cli-darwin-x64` CLI

### 4. VS Code Tunnel ARM64 Server Limitation
- **Problem**: Even with ARM64 CLI, VS Code tunnel server downloads x64 version causing Rosetta errors
- **Root Cause**: VS Code tunnel has limited ARM64 server support - server component defaults to x64
- **Current Status**: KNOWN LIMITATION - Cannot be fixed at script level
- **Impact**: Tunnels may not work properly on ARM64 systems until Microsoft resolves server architecture detection
- **Workarounds**: 
  - ✅ **Use VS Code Remote SSH** (recommended) - see SSH Setup section below
  - Run tunnel on x64 host and connect from ARM64 client
  - Wait for Microsoft to improve ARM64 tunnel server support

## Current Solutions

### Claude CLI Installation
- **Solution**: Added `npm install -g @anthropic-ai/claude-code` to postCreateCommand in `.devcontainer/devcontainer.json`
- **Status**: Will work after container rebuild

### VS Code Tunnel Script
- **Solution**: Modified `bin/tunnel` to download correct CLI and server architectures
- **How it works**:
  1. Detects system OS and architecture using `uname`
  2. Downloads the correct VS Code CLI variant for the platform (if not cached)
  3. Sets `VSCODE_CLI_PLATFORM` environment variable to control server download
  4. Runs tunnel command using the standalone CLI with matching architecture
- **Supported Platforms**:
  - Linux ARM64 (aarch64) → `cli-alpine-arm64` + `linux-arm64` server
  - Linux x64 (x86_64/amd64) → `cli-alpine-x64` + `linux-x64` server
  - macOS ARM64 (arm64) → `cli-darwin-arm64`
  - macOS x64 (x86_64) → `cli-darwin-x64`
- **Status**: Ready to use across all major architectures

### Current File Contents

**`.devcontainer/devcontainer.json`**:
- Uses Microsoft's pre-built Node.js 20 image
- postCreateCommand: `"npm install && npm install -g @anthropic-ai/claude-code"`
- Does NOT use the custom Dockerfile

**`bin/tunnel`**:
- Detects OS and architecture automatically
- Downloads appropriate VS Code CLI variant to `.vscode-cli/` on first run
- Supports Linux (Alpine builds) and macOS across x64 and ARM64 architectures
- Executes tunnel command using `/workspaces/notion-cli/.vscode-cli/code tunnel`
- ⚠️ **Note**: Has ARM64 server limitation - consider using SSH instead

**`bin/setup-ssh`**:
- Sets up SSH server with key-based authentication
- Generates SSH host keys and user key pair automatically
- Configures SSH daemon on port 2222
- Enables VS Code Remote SSH access (works on all architectures)

## Remote Access Solutions

### Tailscale Setup (Recommended for Internet Access)

For secure remote access from anywhere (like your iPad), use Tailscale:

1. **Automatic Setup**: Tailscale is configured in devcontainer.json
2. **Authentication**: Run `bin/setup-tailscale` after container rebuild
3. **iPad Access**: See `IPAD_ACCESS_GUIDE.md` for detailed instructions
4. **Benefits**:
   - ✅ Works from anywhere with internet
   - ✅ End-to-end encrypted (WireGuard)
   - ✅ No port forwarding needed
   - ✅ Works with all architectures

### SSH Setup (Local Network Alternative)

For reliable local network access on all architectures, use VS Code Remote SSH:

### Automatic Setup
The devcontainer is configured to automatically set up SSH during container creation. After rebuilding:

1. **SSH server** runs on port 2222
2. **SSH keys** are automatically generated  
3. **Port forwarding** is configured in devcontainer.json

### Manual Connection Steps
1. Install the **Remote - SSH** extension in VS Code
2. Open Command Palette (`Cmd/Ctrl+Shift+P`)
3. Run **"Remote-SSH: Connect to Host..."**
4. Use connection string: `node@localhost:2222`
5. When prompted for SSH key, copy the private key from:
   ```bash
   cat /home/node/.ssh/id_rsa
   ```

### Benefits over Tunnels
- ✅ **Full ARM64 support** - no architecture limitations
- ✅ **More reliable** - SSH is a mature protocol
- ✅ **Better performance** - direct connection vs tunnel relay
- ✅ **Works offline** - no internet dependency after setup

### Manual SSH Setup
If needed, run: `bin/setup-ssh`

## Important Note
The Dockerfile in the root directory is NOT being used by VS Code devcontainers. The devcontainer uses the configuration in `.devcontainer/devcontainer.json` instead.