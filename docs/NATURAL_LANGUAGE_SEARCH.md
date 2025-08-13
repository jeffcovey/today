# Natural Language Search Feature

## Overview

The Notion CLI includes AI-powered natural language search that understands context and intent to find relevant items across any Notion database using Claude AI.

## Key Features

- **Database-agnostic**: Works with any Notion database (tasks, projects, contacts, etc.)
- **Flexible queries**: Handles direct searches, questions, complex requests, and even mood-based queries
- **Claude-powered**: Uses Anthropic's Claude 3 Haiku for fast, intelligent search
- **Smart fallback**: Falls back to enhanced keyword search if API is unavailable
- **Privacy-conscious**: Only sends necessary metadata to Claude

## Setup

1. Get your Anthropic API key from https://console.anthropic.com/
2. Add to your `.env` file:

   ```
   ANTHROPIC_API_KEY=sk-ant-api...your-key-here
   ```

   Or export it:

   ```bash
   export ANTHROPIC_API_KEY="your-api-key-here"
   ```

## Query Examples

### Direct Searches

- "github tasks"
- "contact John"
- "project deadlines"

### Open-ended Questions

- "what should I work on today?"
- "what's most important?"
- "what have I been neglecting?"

### Complex Requests

- "quick wins to feel productive"
- "tasks I've been avoiding"
- "things related to money"
- "projects that need attention"

### Mood/Feeling Based

- "I'm bored"
- "I need to be productive"
- "something relaxing"
- "I'm overwhelmed"

### Health & Wellness

- "what tasks could improve my health?"
- "health-related items"
- "wellness activities"

## Usage

1. Select "🔍 Search tasks (natural language)" from main menu
2. Enter any query - be as specific or vague as you like
3. Browse results with metadata (project, due date, etc.)
4. Actions:
   - ✅ Mark as done
   - 🔗 Open in Notion
   - 📋 Copy URL to clipboard

## How It Works

### With Claude API

1. Analyzes your query to understand intent
2. Reviews item titles and all properties
3. Considers context (database type, relationships, dates)
4. Returns semantically relevant results
5. Response time: 1-2 seconds

### Fallback Mode (No API Key)

If no API key is set, uses enhanced keyword matching:
- Expands queries to related concepts (health → doctor, vaccine, wellness)
- Scores based on title and property matches
- Still provides useful results for common queries

## Extending to Other Databases

The search automatically adapts to different database types:

### Tasks Database

- Considers: Stage, Project assignment, Due dates, Priority
- Good for: "what should I do?", "urgent tasks", "quick wins"

### Projects Database

- Considers: Status, Category, Deadlines
- Good for: "active projects", "stalled initiatives", "upcoming deadlines"

### Contacts Database

- Considers: Company, Last contact date, Relationship type
- Good for: "people to follow up with", "important contacts", "neglected relationships"

### Custom Databases

The system automatically detects and uses any properties in your database.

## Docker Usage

```bash
# Build and run
docker-compose up -d

# Use the CLI
docker exec -it notion-cli ./bin/notion-cli
```

## Cost & Performance

- **Claude 3 Haiku**: ~$0.001 per search
- **Response time**: 1-2 seconds
- **Fallback search**: Instant, free

## Privacy & Security

- Only sends item titles and basic metadata to Claude
- Your data is never used to train AI models
- Search queries are not logged or stored
- Supports corporate proxy settings via HTTPS_PROXY

## Troubleshooting

### "API key not found"

Ensure ANTHROPIC_API_KEY is in your `.env` file or environment

### "Rate limit exceeded"

Claude has rate limits - wait a moment and try again

### Poor search results

Make sure your API key is set - the fallback search is less intelligent

## Future Enhancements

- Query history and favorites
- Saved searches
- Batch operations on results
- Custom property importance weights
- Learning from your selections
