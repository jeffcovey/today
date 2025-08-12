# Drafts ↔ GitHub Notes Bidirectional Sync Design

## Overview
Create a two-way sync between Drafts app and the `notes/` directory in GitHub, allowing you to work seamlessly across platforms.

## Drafts Organization Strategy

### Using Tags to Represent Folders
Since Drafts doesn't have traditional folders, we'll use tags to mirror the directory structure:

```
notes/daily/2025-08-12-note.md     →  Tags: ["notes", "notes/daily"]
notes/tasks/tasks.md               →  Tags: ["notes", "notes/tasks"]
notes/concerns/2025-08-12.md       →  Tags: ["notes", "notes/concerns"]
notes/reviews/2025-08-12.md        →  Tags: ["notes", "notes/reviews"]
```

### Draft Metadata Storage
Each draft will store GitHub metadata in its content using a YAML-like header:

```markdown
---
github_path: notes/daily/2025-08-12-note.md
github_sha: abc123def456
last_sync: 2025-08-12T14:30:00Z
sync_status: synced
---

# Your Note Content
The actual content starts here...
```

## Sync Architecture

### 1. GitHub → Drafts Sync Script
**Location:** `scripts/sync-github-to-drafts.js`

```javascript
// Core Logic:
1. Fetch all files from notes/ directory via GitHub API
2. For each file:
   - Check if draft exists (by searching for github_path in content)
   - If exists: Update if GitHub version is newer
   - If not exists: Create new draft with appropriate tags
3. Handle deletions: Archive drafts for deleted GitHub files
```

### 2. Drafts → GitHub Sync Action
**Location:** `scripts/sync-drafts-to-github.js`

```javascript
// Core Logic:
1. Query all drafts with tag "notes"
2. For each draft:
   - Extract github_path from metadata
   - If no path: Determine path from tags (notes/tasks → notes/tasks/untitled.md)
   - Check GitHub for existing file
   - Upload/update if draft is newer
3. Handle special files (tasks.md, streaks-today.md) with append logic
```

### 3. Conflict Resolution

**Strategy:** Last-Write-Wins with Backup
- Compare `last_sync` timestamp with GitHub's last commit time
- If conflict detected:
  - Create backup draft with tag "conflict-backup"
  - Apply the newer version
  - Notify user via Drafts notification

## Implementation Plan

### Phase 1: GitHub → Drafts (Read-Only)
1. Create Drafts action to pull all notes from GitHub
2. Use workspace "GitHub Notes" to isolate synced content
3. Apply tags based on directory structure
4. Store GitHub metadata in draft content

### Phase 2: Drafts → GitHub (Write)
1. Extend existing upload action to handle sync metadata
2. Detect changes since last sync
3. Batch upload modified drafts
4. Update sync timestamps

### Phase 3: Bidirectional Sync
1. Implement conflict detection
2. Add sync status indicators (tags: "needs-sync", "synced", "conflict")
3. Create sync dashboard draft showing status
4. Add automatic sync triggers (on app launch, every 30 min)

## Special Handling

### Tasks.md
- Append new tasks rather than overwrite
- Archive completed tasks during sync
- Preserve task ordering

### Streaks-today.md
- Always overwrite (it's regenerated daily)
- Convert between Drafts checklist format and markdown

### Inbox Processing
- Drafts tagged "inbox" upload to notes/inbox/
- After GitHub processes (via bin/sync), update draft tags to reflect new location

## Drafts Actions Required

### 1. "Sync from GitHub" Action
```javascript
// Pulls latest from GitHub
// Updates/creates drafts
// Shows sync summary
```

### 2. "Sync to GitHub" Action
```javascript
// Pushes changes to GitHub
// Updates sync metadata
// Handles conflicts
```

### 3. "Quick Note to Inbox" Action
```javascript
// Simplified version of current action
// Just adds to inbox for processing
```

### 4. "Sync Status" Action
```javascript
// Shows sync dashboard
// Lists conflicts, pending syncs
// Manual conflict resolution
```

## Benefits

1. **Offline Access:** Work in Drafts offline, sync when connected
2. **Platform Native:** Use Drafts' excellent iOS/Mac editing experience
3. **Version Control:** GitHub maintains history, Drafts for active editing
4. **Automation:** Drafts actions + GitHub Actions for workflows
5. **Search:** Use Drafts' powerful search across all notes

## Technical Requirements

- GitHub Personal Access Token (stored in Drafts Credentials)
- Drafts Pro (for workspaces and advanced actions)
- Custom workspace "GitHub Notes" to separate synced content
- Tags for organization (auto-created during sync)

## Example Sync Flow

1. **Morning:** Run "Sync from GitHub" to get latest notes
2. **Throughout Day:** Create/edit drafts with appropriate tags
3. **Evening:** Run "Sync to GitHub" to push changes
4. **Automatic:** Background sync every 30 minutes (if configured)

## Error Handling

- Network failures: Queue changes for next sync
- API rate limits: Implement exponential backoff
- Invalid content: Skip file, log error, continue sync
- Large files: Chunk uploads, show progress

## Future Enhancements

1. **Selective Sync:** Choose which folders to sync
2. **Collaborative Editing:** Detect when others edit files
3. **Attachments:** Handle images/PDFs via GitHub LFS
4. **Templates:** Create note templates in Drafts
5. **Smart Filing:** AI-powered auto-tagging based on content

---

## Next Steps

1. Test GitHub API access from Drafts
2. Create prototype "Sync from GitHub" action
3. Design Drafts workspace layout
4. Implement metadata header parsing
5. Build incremental sync logic

This design leverages Drafts' strengths (quick capture, great editing) with GitHub's strengths (version control, universal access, automation).