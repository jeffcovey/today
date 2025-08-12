# Drafts Today Sync Setup Guide

## Prerequisites

1. **Drafts Pro** - Required for workspaces and advanced actions
2. **GitHub Personal Access Token** - For API access
3. **The sync scripts** from `/scripts/` directory

## Step 1: Create GitHub Personal Access Token

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Give it a name like "Drafts Sync"
4. Select the **`repo`** scope (full control of private repositories)
5. Click "Generate token"
6. **Copy the token immediately** (you won't see it again!)

## Step 2: Set Up Drafts Workspace

1. In Drafts, tap the workspace icon (top left)
2. Tap "Manage Workspaces"
3. Create new workspace: **"GitHub Notes"**
4. Configure the workspace:
   - **Default Tags:** `github-sync`
   - **Tag Filter:** Show drafts with any of: `github-sync`, `notes`
   - **Include Action Groups:** All your sync actions

## Step 3: Install Sync Actions

### Action 1: Sync from GitHub

1. Create new action: "📥 Sync from GitHub"
2. Add a Script step
3. Paste the content from `scripts/sync-today-to-drafts.js`
4. Icon suggestion: ⬇️ or 📥
5. Assign to workspace: Today

### Action 2: Sync to GitHub

1. Create new action: "📤 Sync to GitHub"
2. Add a Script step
3. Paste the content from `scripts/sync-drafts-to-today.js`
4. Icon suggestion: ⬆️ or 📤
5. Assign to workspace: Today

### Action 3: Sync Status

1. Create new action: "📊 Sync Status"
2. Add a Script step
3. Paste the content from `scripts/drafts-today-status.js`
4. Icon suggestion: 📊 or ℹ️
5. Assign to workspace: Today

### Action 4: Quick Upload (Optional)

1. Keep your existing action from `scripts/drafts-to-github-action.js`
2. Rename to: "⚡ Quick Upload to Inbox"
3. Use for quick captures that go straight to inbox

## Step 4: Configure GitHub Credentials

1. Run any sync action for the first time
2. When prompted, enter your GitHub Personal Access Token
3. Drafts will securely store it in the keychain
4. You won't need to enter it again

## Step 5: Initial Sync

1. Switch to the "GitHub Notes" workspace
2. Run "📥 Sync from GitHub"
3. Wait for completion (may take a minute first time)
4. You should see all your notes appear as drafts!

## Step 6: Organize Your Tags

After initial sync, your drafts will have these tags:

- `github-sync` - All synced drafts
- `notes` - Root notes directory
- `notes/daily` - Daily journal entries
- `notes/tasks` - Task lists
- `notes/concerns` - Concerns and worries
- `notes/reviews` - Daily review files
- `notes/ogm-work` - OlderGay.Men work

## Usage Workflow

### Daily Workflow

**Morning:**
1. Open Drafts
2. Switch to "GitHub Notes" workspace
3. Run "📥 Sync from GitHub"
4. Work with your notes throughout the day

**Evening:**
1. Run "📤 Sync to GitHub"
2. Check "📊 Sync Status" for any issues
3. Your changes are now in GitHub!

### Creating New Notes

1. Create new draft in Drafts
2. Add appropriate tag (e.g., `notes/daily`)
3. Write your content
4. Run "📤 Sync to GitHub" when ready

### Handling Special Files

**tasks.md:**
- Will append new tasks, not overwrite
- Completed tasks are automatically archived

**streaks-today.md:**
- Always overwrites (it's regenerated daily)

**Inbox notes:**
- Use "⚡ Quick Upload to Inbox" for quick capture
- They'll be processed by `bin/sync` on the server

## Advanced Features

### Keyboard Shortcuts (iPad/Mac)

Set up keyboard shortcuts for quick access:
- ⌘⇧S - Sync from GitHub
- ⌘⇧U - Sync to GitHub
- ⌘⇧I - Sync Status

### Action Groups

Create an action group "GitHub Sync" containing:
1. Sync from GitHub
2. Sync to GitHub
3. Sync Status
4. Quick Upload to Inbox

### Automatic Sync

Create a "Auto Sync" action that:
1. Runs "Sync from GitHub"
2. Waits 2 seconds
3. Shows notification with results

Trigger this:
- On workspace load
- Every 30 minutes (using Drafts automation)

## Troubleshooting

### "GitHub credentials required"
- Token may have expired
- Delete stored credential and re-enter token

### "Sync failed: 404"
- Check repository name and owner in script config
- Ensure token has `repo` scope

### Drafts not appearing after sync
- Check workspace tag filter
- Ensure drafts have `github-sync` tag
- Run "Sync Status" to see what happened

### Merge conflicts
- Check "Sync Status" for conflicts
- Drafts with conflicts are tagged `sync-conflict`
- Manually resolve and remove tag

## Tips

1. **Use workspace badges** to see unsync'd draft count
2. **Star the workspace** for quick access
3. **Create templates** for common note types
4. **Use Drafts share extension** to capture from anywhere
5. **Enable workspace tinting** to visually distinguish GitHub Notes

## Metadata Format

Each synced draft contains metadata:

```markdown
---
github_path: notes/daily/2025-08-12.md
github_sha: abc123def456
last_sync: 2025-08-12T14:30:00Z
sync_status: synced
---

Your content here...
```

Don't edit the metadata manually unless you know what you're doing!

## Security Note

Your GitHub token is stored securely in the iOS/macOS keychain. It's never visible in the draft content or action code after initial entry.

---

## Next Steps

1. Test the sync with a few notes
2. Set up keyboard shortcuts for efficiency
3. Consider automation for regular syncs
4. Customize workspace appearance
5. Create note templates for consistency

Enjoy seamless note synchronization between Drafts and GitHub! 🎉