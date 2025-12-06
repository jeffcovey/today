# Natural Language Search Feature

## Overview

The email manager includes AI-powered natural language search that understands context and intent to find relevant emails using Claude AI.

## Key Features

- **Flexible queries**: Handles direct searches, questions, and complex requests
- **Claude-powered**: Uses Anthropic's Claude for intelligent search
- **Smart fallback**: Falls back to keyword search if API is unavailable

## Setup

1. Get your Anthropic API key from https://console.anthropic.com/
2. Add to your `.env` file:

   ```
   ANTHROPIC_API_KEY=sk-ant-api...your-key-here
   ```

## Query Examples

### Direct Searches

- "emails from John"
- "invoices"
- "meeting requests"

### Open-ended Questions

- "what needs a response?"
- "important unread emails"
- "emails I've been ignoring"

### Complex Requests

- "emails about the project deadline"
- "messages from last week"
- "follow-up needed"

## How It Works

### With Claude API

1. Analyzes your query to understand intent
2. Reviews email subjects and metadata
3. Returns semantically relevant results
4. Response time: 1-2 seconds

### Fallback Mode (No API Key)

If no API key is set, uses keyword matching on email subjects and content.

## Cost & Performance

- **Claude API**: ~$0.001 per search
- **Response time**: 1-2 seconds
- **Fallback search**: Instant, free

## Troubleshooting

### "API key not found"

Ensure ANTHROPIC_API_KEY is in your `.env` file or environment.

### Poor search results

Make sure your API key is set - the fallback search is less intelligent.
