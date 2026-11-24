FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules, curl, sqlite, bash, git, GitHub CLI,
# openssh-client (needed by git for SSH remotes — git-sync pushes to git@github.com:...),
# and the Cairo/Pango/etc stack required by the `canvas` package (used by the
# data-graphing plugin). pkgconfig + *-dev packages are needed because we build
# canvas from source in the next layer — prebuilt binaries aren't published for
# Alpine/musl on ARM64.
RUN apk add --no-cache \
    python3 make g++ pkgconfig \
    curl sqlite bash git openssh-client github-cli \
    # GNU grep: BusyBox grep lacks --exclude-dir (markdown-tasks finds task files with it)
    grep \
    # For the web console (/_console): mail (config in vault/today/neomuttrc,
    # HTML through lynx) and tmux
    neomutt lynx tmux \
    cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev

# neomutt as on the Mac mini, so plain `neomutt` works in the web console: its
# config is the vault's today/neomuttrc, and HTML mail goes through lynx via
# config/neomutt/mailcap. Both links resolve through the /app bind mount.
RUN mkdir -p /root/.config/neomutt \
    && ln -sf /app/vault/today/neomuttrc /root/.config/neomutt/neomuttrc \
    && ln -sf /app/config/neomutt/mailcap /root/.mailcap

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
