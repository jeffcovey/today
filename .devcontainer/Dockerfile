FROM mcr.microsoft.com/devcontainers/javascript-node:20

# Install build dependencies for native modules (better-sqlite3) and sqlite3 CLI
# Note: python3 is required for node-gyp to compile native modules like better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ sqlite3 curl && rm -rf /var/lib/apt/lists/*

# Docker CLI + Compose plugin are installed by the docker-outside-of-docker
# devcontainer feature (see .devcontainer/devcontainer.json). The feature also
# handles /var/run/docker.sock group permissions correctly, which a manual
# Dockerfile install does not. Don't duplicate it here.

# Install CLI tools: ripgrep, fd-find, bat, ruby (for mdless)
RUN apt-get update && apt-get install -y ripgrep fd-find bat ruby ruby-dev && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI from official repo (apt version is outdated)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Create symlinks for common aliases
RUN ln -s /usr/bin/batcat /usr/local/bin/bat 2>/dev/null || true && \
    ln -s /usr/bin/fdfind /usr/local/bin/fd 2>/dev/null || true

# Install Claude Code to user home directory via official installer
RUN su node -c "curl -fsSL https://claude.ai/install.sh | bash"
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Install standalone VS Code CLI for `code tunnel` (separate from the
# devcontainer's remote-cli wrapper at /usr/local/bin/code).
# Used by .devcontainer/personal-startup.sh.
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) VSCODE_ARCH=cli-linux-x64 ;; \
      arm64) VSCODE_ARCH=cli-linux-arm64 ;; \
      *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://update.code.visualstudio.com/latest/${VSCODE_ARCH}/stable" -o /tmp/vscode-cli.tar.gz && \
    tar -xzf /tmp/vscode-cli.tar.gz -C /tmp && \
    mv /tmp/code /usr/local/lib/vscode-cli && \
    chmod +x /usr/local/lib/vscode-cli && \
    rm /tmp/vscode-cli.tar.gz

# Install mdless (Ruby gem for markdown viewing)
RUN gem install mdless --no-document

# Install Fly CLI
RUN curl -L https://fly.io/install.sh | sh && \
    ln -s /root/.fly/bin/flyctl /usr/local/bin/fly

# Set working directory
WORKDIR /workspaces/today