FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src/ ./src/
COPY bin/ ./bin/

# Make the CLI executable
RUN chmod +x ./bin/notion-cli

# Set up environment
ENV NODE_ENV=production

# Set the entrypoint
ENTRYPOINT ["./bin/notion-cli"]
