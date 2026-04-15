FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules, curl, sqlite, bash, git, GitHub CLI,
# and the Cairo/Pango/etc stack required by the `canvas` package (used by the
# data-graphing plugin). pkgconfig + *-dev packages are needed because we build
# canvas from source in the next layer — prebuilt binaries aren't published for
# Alpine/musl on ARM64.
RUN apk add --no-cache \
    python3 make g++ pkgconfig \
    curl sqlite bash git github-cli \
    cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev

# Copy package files
COPY package*.json ./

# Install dependencies (with native module rebuild)
RUN npm install --build-from-source

# Copy source code and configuration
COPY src/ ./src/
COPY bin/ ./bin/
COPY config/ ./config/

# Make all CLI scripts executable
RUN chmod +x ./bin/*

# Create directories for cache and config
RUN mkdir -p /app/config /app/notes

# Set up environment
ENV NODE_ENV=production

# Configure git to trust the /app directory and set pull strategy
RUN git config --global --add safe.directory /app && \
    git config --global pull.rebase false

# Default command (can be overridden)
CMD ["node", "src/cli.js"]
