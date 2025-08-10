FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules, curl, sqlite, bash, git, and SSH
RUN apk add --no-cache python3 make g++ curl sqlite bash git openssh-client

# Install VS Code CLI with tunnel support
RUN curl -Lk 'https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64' --output /tmp/vscode_cli.tar.gz && \
    tar -xf /tmp/vscode_cli.tar.gz -C /tmp/ && \
    mv /tmp/code /usr/local/bin/code-cli && \
    rm /tmp/vscode_cli.tar.gz && \
    chmod +x /usr/local/bin/code-cli

# Install claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code and configuration
COPY src/ ./src/
COPY bin/ ./bin/
COPY config/ ./config/
COPY TODAY.md ./

# Make all CLI scripts executable
RUN chmod +x ./bin/*

# Create directories for cache and config
RUN mkdir -p /app/.notion-cache /app/config /app/notes

# Set up environment
ENV NODE_ENV=production

# Configure git to trust the /app directory
RUN git config --global --add safe.directory /app

# Copy bashrc for colorful prompt
COPY .docker-bashrc /root/.bashrc

# Default to bash for interactive use (with login shell for .bashrc)
CMD ["/bin/bash", "-l"]