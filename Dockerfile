FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Make the CLI executable
RUN chmod +x ./src/index.js

# Create symlink for global access
RUN npm link

# Set up environment
ENV NODE_ENV=production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S notion -u 1001 -G nodejs

USER notion

ENTRYPOINT ["notion-cli"]
CMD ["edit"]