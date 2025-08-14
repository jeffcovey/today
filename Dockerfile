FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules, curl, sqlite, bash, git
RUN apk add --no-cache python3 make g++ curl sqlite bash git

# Copy package files
COPY package*.json ./

# Install dependencies (with native module rebuild)
RUN npm install --build-from-source

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

# Default command (can be overridden)
CMD ["node", "src/cli.js"]