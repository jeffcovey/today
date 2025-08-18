FROM mcr.microsoft.com/devcontainers/javascript-node:20

# Install build dependencies for native modules (better-sqlite3) and sqlite3 CLI
RUN apt-get update && apt-get install -y python3 make g++ sqlite3 curl && rm -rf /var/lib/apt/lists/*

# Install Turso CLI
RUN curl -sSfL https://get.tur.so/install.sh | bash && \
    mv /root/.turso/bin/turso /usr/local/bin/turso

# Install CLI tools: ripgrep, fd-find, bat, ruby (for mdless)
RUN apt-get update && apt-get install -y ripgrep fd-find bat ruby ruby-dev && rm -rf /var/lib/apt/lists/*

# Create symlinks for common aliases
RUN ln -s /usr/bin/batcat /usr/local/bin/bat 2>/dev/null || true && \
    ln -s /usr/bin/fdfind /usr/local/bin/fd 2>/dev/null || true

# Install global packages in Docker layers
RUN npm install -g @anthropic-ai/claude-code
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Install mdless (Ruby gem for markdown viewing)
RUN gem install mdless --no-document

# Install Fly CLI
RUN curl -L https://fly.io/install.sh | sh && \
    ln -s /root/.fly/bin/flyctl /usr/local/bin/fly

# Set working directory
WORKDIR /workspaces/today