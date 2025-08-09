FROM mcr.microsoft.com/devcontainers/javascript-node:20

# Install build dependencies for native modules (better-sqlite3) and sqlite3 CLI
RUN apt-get update && apt-get install -y python3 make g++ sqlite3 && rm -rf /var/lib/apt/lists/*

# Install global packages in Docker layers
RUN npm install -g @anthropic-ai/claude-code
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Set working directory
WORKDIR /workspaces/today