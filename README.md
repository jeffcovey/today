# Notion CLI

A command line interface for batch editing Notion database items. Select multiple database items and change their properties all at once through an interactive CLI interface.

## Features

- 🗄️ Browse and select from your Notion databases
- 📝 Select multiple database items for batch editing
- ⚡ Edit multiple properties at once
- 🔄 Interactive CLI with confirmation steps
- 🐳 Docker support for easy deployment
- 🛡️ Error handling and validation

## Prerequisites

- Node.js 18+ or Docker
- A Notion integration token

## Setup

### 1. Create a Notion Integration

1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click "New integration"
3. Give it a name and select your workspace
4. Copy the "Internal Integration Token"

### 2. Share Database with Integration

1. Open the Notion database you want to edit
2. Click "Share" in the top right
3. Click "Invite" and search for your integration name
4. Grant appropriate permissions

### 3. Install and Configure

#### Option A: Local Installation

```bash
# Clone the repository
git clone <repository-url>
cd notion-cli

# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Edit .env and add your Notion token
NOTION_TOKEN=your_notion_integration_token_here
```

#### Option B: Docker

```bash
# Create environment file
cp .env.example .env

# Edit .env and add your Notion token
NOTION_TOKEN=your_notion_integration_token_here

# Build and run with Docker Compose
docker-compose up --build
```

## Usage

### Local Usage

```bash
# Run the interactive CLI
npm start

# Or use the edit command directly
npm run start edit
```

### Docker Usage

```bash
# Using Docker Compose
docker-compose run notion-cli

# Using Docker directly
docker build -t notion-cli .
docker run -it --env-file .env notion-cli
```

## How It Works

1. **Database Selection**: Choose from your accessible Notion databases
2. **Item Selection**: Select which database items to edit (checkbox interface)
3. **Property Selection**: Choose which properties to modify
4. **Value Input**: Enter new values for selected properties
5. **Confirmation**: Review changes before applying
6. **Batch Update**: All selected items are updated with new values

## Supported Property Types

- ✅ Title
- ✅ Rich Text
- ✅ Number
- ✅ Select
- ✅ Multi-select
- ✅ Date
- ✅ Checkbox
- ✅ URL
- ✅ Email
- ✅ Phone Number

## Error Handling

The CLI includes comprehensive error handling:
- Invalid Notion tokens
- Network connectivity issues
- Permission errors
- Invalid property values
- Partial update failures

## Examples

### Batch Update Task Status

1. Select your "Tasks" database
2. Choose multiple tasks
3. Select the "Status" property
4. Set all selected tasks to "In Progress"

### Update Due Dates

1. Select your project database
2. Choose items to update
3. Select the "Due Date" property
4. Set a new deadline for all items

## Development

```bash
# Run in development mode with auto-restart
npm run dev

# Build Docker image
docker build -t notion-cli .
```

## License

MIT
