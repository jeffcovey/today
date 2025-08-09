# Notes Collection

This directory contains notes captured via Drafts and synced through GitHub.

## Setup Instructions

### 1. GitHub Personal Access Token
1. Go to https://github.com/settings/tokens (your personal settings, not the organization)
2. Create a new token with `repo` scope
3. Copy the token for use in Drafts
   - Note: Use your personal token even for organization repos - as long as you have write access to the repo, it will work

### 2. Drafts Action Setup
1. Open Drafts on iOS/Mac
2. Create a new Action
3. Add a "Script" step
4. Copy the contents of `scripts/drafts-to-github-action.js`
5. Update the configuration:
   - The owner and repo are already set to `OlderGay-Men/notion-cli`
   - Replace `YOUR_GITHUB_TOKEN` with your personal access token (or use Drafts Credentials for secure storage)

### 3. Usage
- Write your note in Drafts
- First line becomes the title (use # for markdown heading)
- Run the action to upload to GitHub
- Notes are automatically organized by type:
  - Tasks (containing checkboxes) → `/tasks/`
  - Daily notes → `/daily/`
  - Ideas (tagged #idea) → `/ideas/`
  - Reference (tagged #reference) → `/reference/`

### 4. Syncing Locally
Run `./scripts/sync-notes.sh` to pull latest notes from GitHub.

## Note Format Examples

### Daily Note
```markdown
# Daily Note 2024-01-15

Today's thoughts and activities...
```

### Task List (TaskPaper format)
```markdown
# Project Tasks

Project A:
- [ ] Complete design review
- [ ] Update documentation
- [x] Fix bug #123
```

### Idea Note
```markdown
# App Feature Idea
#idea

Description of the new feature...
```

## Tips
- Use markdown for formatting
- First line becomes the filename (sanitized)
- Tags help with automatic organization
- Files are named with date prefix for chronological sorting