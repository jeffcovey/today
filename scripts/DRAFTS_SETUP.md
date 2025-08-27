# Drafts Sync Setup Guide

## Overview

These scripts enable two-way sync between Drafts app and your Today vault on the droplet. No GitHub dependency!

## Scripts

### 1. drafts-unified-sync.js

**Purpose:** Full two-way sync between Drafts and vault
**Features:**
- Pull from vault to Drafts
- Push from Drafts to vault (via inbox)
- Two-way sync with conflict detection
- Full sync or incremental sync options

### 2. drafts-send-to-inbox.js

**Purpose:** Quick upload of single draft to inbox
**Features:**
- Send current draft directly to vault inbox
- Auto-generates filename with timestamp
- Tags draft as "uploaded-to-inbox"

## Setup Instructions

### Step 1: Get Your API Key

```bash
ssh root@today.jeffcovey.net "grep INBOX_API_KEY /opt/today/.inbox-api-key | cut -d= -f2"
```

Save this key - you'll need it for both scripts.

### Step 2: Install Unified Sync Action

1. Open Drafts app
2. Go to Actions (bottom bar)
3. Create new Action Group called "Today"
4. Create new Action called "Today Sync"
5. Add a Script step
6. Copy entire contents of `drafts-unified-sync.js`
7. Paste into the script editor
8. Save the action

### Step 3: Install Send to Inbox Action

1. Create new Action called "Send to Inbox"
2. Add a Script step
3. Copy entire contents of `drafts-send-to-inbox.js`
4. Paste into the script editor
5. Save the action

### Step 4: First Run Setup

When you run either action for the first time:
1. You'll be prompted for credentials
2. Enter your API key from Step 1
3. The key will be securely stored in Drafts

## Usage

### Today Sync Action

Shows a menu with options:
- **📥 Pull from Vault** - Download vault files to Drafts
- **📤 Push to Vault** - Upload modified drafts to inbox
- **🔄 Two-Way Sync** - Smart sync in both directions
- **🔄 Full Sync** - Complete sync of all files
- **📋 Status** - Show sync status

### Send to Inbox Action

- Uploads current draft immediately to inbox
- No menu - direct upload
- Good for quick capture

## How It Works

1. **Pull:** Fetches files from `/api/vault/*` endpoints
2. **Push:** Uploads to `/api/inbox/upload` endpoint
3. **Sync State:** Tracked via special "Today Sync State" draft
4. **Tags:** Files organized by vault path as tags (e.g., "notes-daily")
5. **Metadata:** Hidden metadata in drafts tracks sync status

## Troubleshooting

### API Key Issues

- Make sure you copied the full key
- Don't include quotes or spaces
- Key should be 64 characters long

### Connection Issues

- Check droplet is accessible: `curl https://today.jeffcovey.net/api/health`
- Verify API key: `curl -H "X-API-Key: YOUR_KEY" https://today.jeffcovey.net/api/vault/list`

### Sync Issues

- Check "Today Sync State" draft for last sync time
- Use "Full Sync" to reset if needed
- Deleted drafts go to Drafts trash (not deleted from vault)

## Server Deployment

The vault-api service on your droplet handles both read and write operations:
- Runs on port 3334
- Combines former vault-api and inbox-api functionality
- Nginx routes `/api/vault/*` and `/api/inbox/*` to this service
- Service auto-starts on droplet reboot

To update the server deployment:

```bash
./bin/update-vault-api
```

## Important Notes

- **No GitHub:** These scripts work directly with your droplet only
- **Inbox writes:** Push operations write to `vault/notes/inbox/`
- **Manual filing:** Move files from inbox to proper locations on droplet
- **Sync tags:** Don't manually edit "today-sync" tagged drafts metadata
- **API key security:** Never share your API key publicly
