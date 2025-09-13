# Today

A personal command center for reviewing everything coming in, managing plans and dreams, and deciding what to do each day to be happy and productive. Integrates multiple data sources including Notion, email, calendar, and local task management to create a unified daily workflow.

## Features

### 🎯 **Productivity Management**

- 🌅 **Morning Routine Management** - Track and complete daily morning tasks
- 📋 **Today's Plan** - Manage daily planning items  
- ⚡ **Quick Tasks** - Handle "Now & Then" items efficiently
- 🌙 **Evening Tasks** - Complete evening routine items
- 🏠 **Day-End Chores** - Track household and end-of-day tasks
- 📥 **Inbox Processing** - Manage items that need processing

### 🤖 **Daily Automation**

- 📅 **Temporal Management** - Automatically create missing Day and Week entries with proper relationships
- 🔄 **Routine Reset** - Reset routine checkboxes daily for recurring tasks
- ♻️ **Repeating Tasks** - Automatically handle completed repeating tasks
- 🗓️ **Relationship Mapping** - Link Days to Weeks and previous Days ("Yesterday" relationships)

### ⚡ **Batch Editing**

- 🗄️ Browse and select from your Notion databases
- 📝 Select multiple database items for batch editing
- 🏷️ Assign tags to multiple tasks at once
- 📅 Edit Do Dates for multiple items
- 🎭 Assign Stage properties to tasks
- 🔄 Interactive CLI with confirmation steps

### 🔍 **Natural Language Search**

- 🤖 AI-powered search across any Notion database
- 💬 Ask questions like "what should I work on?" or "I'm bored"
- 🎯 Handles direct searches, complex queries, and mood-based requests
- 🔄 Multiple AI backends: Claude API, local Ollama, or basic search
- 🔐 Privacy-conscious with automatic fallback

### 🏗️ **Technical Features**

- 💾 **SQLite Caching** - High-performance local caching with incremental sync
- 🐳 **Docker Support** - Easy deployment and automation
- 🛡️ **Error Handling** - Comprehensive validation and error recovery
- ⚡ **Optimized Performance** - Concurrent processing and smart caching

## Prerequisites

- Node.js 18+ or Docker
- A Notion integration token

## Setup

### 1. Create a Notion Integration

1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click "New integration"
3. Give it a name and select your workspace
4. Copy the "Internal Integration Token"

### 2. Share Databases with Integration

For full functionality, share these databases with your integration:

**Required for Basic Features:**
- Action Items (main tasks database)
- Morning Routine
- Evening Tasks  
- Day-End Chores

**Required for Advanced Features:**
- Days (daily tracking)
- Weeks (weekly planning)
- Today's Plan (daily planning items)
- Now and Then (quick tasks)
- Inboxes (items to process)
- Pillars (time tracking areas)

**How to Share:**
1. Open each Notion database
2. Click "Share" in the top right
3. Click "Invite" and search for your integration name
4. Grant "Edit" permissions

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

### Interactive Mode

```bash
# Run the interactive CLI (local)
npm start

# Using Docker Compose
docker-compose run notion

# Direct edit command
npm run start edit
```

### Command Line Operations

#### Task Management

```bash
# Sync and manage tasks
bin/tasks sync                         # Sync all tasks from markdown files
bin/tasks list                         # List all active tasks
bin/tasks list --today                 # Show today's tasks
bin/tasks list --with-notion           # Show tasks imported from Notion
bin/tasks add "New task" --date 2025-08-14
bin/tasks done <id>                    # Mark task as complete

# Notion migration tools
bin/notion-mark-done <task-id>         # Mark task as done in Notion
bin/notion-mark-done --all             # Mark all tasks as done in Notion
bin/tasks clear-notion-ids --force     # Remove Notion IDs after migration
```

#### Daily Automation (Perfect for Cron/Docker)

```bash
# Run all daily automation tasks
notion daily --all

# Individual operations
notion daily --reset-routines          # Reset routine checkboxes
notion daily --mark-repeating-tasks    # Handle completed repeating tasks  
notion daily --create-temporal         # Create missing days/weeks
```

#### Temporal Management

```bash
# Create missing days and weeks with relationships
notion temporal --create-missing-days

# Specify date range
notion temporal --create-missing-days --start-date 2024-01-01 --end-date 2024-01-31
```

#### Docker Automation Examples

```bash
# Daily automation via Docker (great for cron)
docker run --env-file .env notion daily --all

# Create missing temporal entries
docker run --env-file .env notion temporal --create-missing-days
```

## How It Works

### Interactive Productivity Management

1. **Smart Menu**: Automatically shows available routines and tasks based on current status
2. **Routine Management**: Check off morning routine, evening tasks, day-end chores
3. **Quick Access**: Today's plan, quick tasks, and inbox processing readily available
4. **Batch Operations**: Edit multiple database items with powerful selection tools
5. **Real-time Updates**: Changes sync immediately with optimized caching

### Automated Daily Operations

1. **Temporal Structure**: Automatically creates missing Day and Week entries
2. **Relationship Mapping**: Links Days to Weeks and previous Days for continuity
3. **Routine Reset**: Automatically unchecks routine items for the next day
4. **Repeating Tasks**: Converts completed repeating tasks back to repeating status
5. **Cache Optimization**: Intelligent caching ensures fast performance

### Batch Editing Workflow

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

### Daily Productivity Workflow

**Morning:**

```bash
# Reset routines for the day and create any missing temporal entries
notion daily --all

# Or use interactive mode to check off morning routine items
npm start
# → Select "🌅 Complete morning routine"
```

**Throughout the Day:**

```bash
# Interactive management
npm start
# → "📋 Manage today's plan" - Handle daily planning items  
# → "⚡ Quick tasks" - Process quick "now and then" items
# → "📥 Process inboxes" - Clear inbox items
```

**Evening:**

```bash
# Complete evening routines
npm start  
# → "🌙 Complete evening tasks"
# → "🏠 Complete day-end chores"
```

### Batch Editing Examples

**Update Task Status:**
1. Select your "Tasks" database
2. Choose multiple tasks  
3. Select the "Status" property
4. Set all selected tasks to "In Progress"

**Assign Tags to Multiple Tasks:**
1. Choose "🏷️ Assign tags to tasks"
2. Select tasks that need tagging
3. Choose or create tags to assign

**Set Due Dates:**
1. Choose "📅 Edit Do Date for tasks"
2. Select tasks needing deadlines
3. Set new due dates for all selected items

### Automation Examples

**Daily Cron Job:**

```bash
# Add to your cron (runs daily at 6 AM)
0 6 * * * docker run --env-file /path/to/.env notion daily --all
```

**Weekly Temporal Sync:**

```bash
# Ensure Days and Weeks are created for the next week
notion temporal --create-missing-days --start-date $(date +%Y-%m-%d) --end-date $(date -d '+7 days' +%Y-%m-%d)
```

## Remote Development with VS Code Tunnel

The Docker container includes VS Code CLI with tunnel support, allowing you to access your development environment from anywhere.

### Starting a VS Code Tunnel

```bash
# From within the container (or Docker Compose shell)
code tunnel --accept-server-license-terms

# The tunnel will start in /app directory by default
# You can also specify a different directory:
cd /workspaces/notion && code tunnel --accept-server-license-terms
```

### Authentication

1. On first run, you'll receive a device code (e.g., `5AB0-0AF9`)
2. Visit https://github.com/login/device
3. Enter the provided code
4. Once authenticated, you'll receive a tunnel URL (e.g., `https://vscode.dev/tunnel/<machine-name>`)

### Using the Tunnel

- Access your tunnel URL from any browser
- VS Code will open with full access to your container environment
- The tunnel persists as long as the container is running
- To stop the tunnel, press `Ctrl+C` in the terminal

### Alternative Authentication Providers

```bash
# Use Microsoft account instead of GitHub
code tunnel user login --provider microsoft
```

## Documentation

- [Notion Migration Guide](docs/notion-migration.md) - Complete guide for migrating tasks from Notion to Today
- [Notes System](vault/notes/README.md) - Real-time notes synchronization

## Development

```bash
# Run in development mode with auto-restart
npm run dev

# Build Docker image
docker build -t notion-cli .
```

## License

MIT
