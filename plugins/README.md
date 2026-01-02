# Plugins

Plugins integrate external data sources with the Today system. Some plugins sync data to SQLite tables; others provide AI instructions for querying external files or perform utility cleanup tasks.

> ⚠️ **Important:** The local SQLite database is only a **cache** of incoming data. It may be dropped and recreated at any time. If your plugin needs to write data, write it to the **source** (e.g., Todoist, Google Calendar, a markdown file), then read it back to the local database. Never treat the database as the source of truth.

## Directory Structure

```
plugins/
  markdown-time-tracking/
    plugin.toml      # Plugin metadata
    read.js          # Read command (reads data, can be any executable)
    write.js         # Write command (creates/updates entries)
    vault/           # Vault files (templates, scripts, etc.)
      scripts/
        time-tracking-widget.js
  apple-health-auto-export/
    plugin.toml      # Plugin metadata
    read.js          # Read-only plugin (no write command)
```

## Configuration

Plugins are configured in `config.toml`:

```toml
[plugins.markdown-time-tracking.local]
enabled = true
days_to_sync = 365
directory = "vault/logs/time-tracking"
auto_add_topics = true  # Enable AI-powered topic tagging
aiInstructions = """
To check current ongoing activity, read `{directory}/current-timer.md`.
To see entries, read `{directory}/YYYY-MM.md` for the relevant month.

Each line in the monthly file is: `START_ISO8601|END_ISO8601|Description #topic/tag`
Example: `2025-12-09T09:00:00-05:00|2025-12-09T10:30:00-05:00|Working on code #topic/programming`
"""

[plugins.apple-health-auto-export.default]
enabled = true
logs_directory = "vault/logs"
retention_days = 30
ai_instructions = """
Health data is synced to the health_metrics table. Query with SQL or use bin/health commands.

Common metric names in the database:
- Activity: step_count, distance_walking_running, active_energy, flights_climbed
- Heart: heart_rate, heart_rate_variability_sdnn, resting_heart_rate
- Body: weight_body_mass, body_mass_index
- Sleep: sleep_analysis (metadata has stages: rem, deep, core, awake)
- Vitals: respiratory_rate, blood_oxygen_saturation
- Nutrition: dietary_water, dietary_caffeine, alcohol_consumption

Example queries:
- Recent weight: SELECT date, value FROM health_metrics WHERE metric_name = 'weight_body_mass' ORDER BY date DESC LIMIT 7
- Today's steps: SELECT value FROM health_metrics WHERE metric_name = 'step_count' AND date = DATE('now', 'localtime')
- Sleep this week: SELECT date, value as hours, metadata FROM health_metrics WHERE metric_name = 'sleep_analysis' AND date > DATE('now', '-7 days')
"""
```

Each section follows the pattern `[plugins.<plugin-name>.<source-name>]`:
- `plugin-name`: The plugin's `name` from plugin.toml (e.g., `markdown-time-tracking`)
- `source-name`: Your label for this instance (e.g., `local`, `work`, `default`)

Multiple sources create separate database entries (distinguished by the `source` column), avoiding conflicts.

### AI Instructions

Plugins have two levels of AI instructions:

1. **Plugin instructions** (`aiInstructions` in plugin.toml): Tell the AI how to query and use the data. These are defined by the plugin author.

2. **User instructions** (`ai_instructions` in config.toml): Your personal preferences for how to interpret the data. These follow the plugin's built-in instructions.

Use TOML multi-line strings (triple quotes) for longer instructions:

```toml
ai_instructions = """
This is my work time tracking. When reviewing:
- Prioritize entries tagged with #topic/urgent
- Highlight any meetings that ran over 1 hour
- Note patterns in my most productive hours
"""
```

## Auto-Tagging with AI

Plugins that support writing can automatically add topic tags to entries using AI. This feature:

1. Runs after each sync
2. Finds entries missing `#topic/` tags
3. Uses AI to suggest appropriate tags, including ones from your configured list
4. Updates the source and re-syncs to the database

### Enabling Auto-Tagging

Add `auto_add_topics = true` to your plugin source configuration:

```toml
[plugins.markdown-time-tracking.local]
enabled = true
auto_add_topics = true
```

### Configuring Topics

Define your preferred topics in `config.toml`:

```toml
[tags]
topics = [
  "programming",
  "meetings",
  "email",
  "reading",
  "exercise",
  "personal_admin",
  "learning",
]
```

The AI will also discover topics from existing tagged entries, so you don't need to list every topic—just your preferred ones.

### For Plugin Authors

To support auto-tagging, your plugin needs:

1. Both `read` and `write` commands in plugin.toml (makes it read-write)
2. A `taggable_field` setting specifying which field to tag (defaults to `description`)
3. Entry IDs that encode file location (e.g., `filepath:lineNum`) so the auto-tagger can locate and update entries

The auto-tagger uses a file-based updater that parses IDs in the format `sourceId:filepath:lineNum` and updates pipe-delimited files. If your plugin uses a different format, the auto-tagger won't modify your files (it fails gracefully).

## plugin.toml Format

```toml
# Plugin metadata
name = "my-plugin"
displayName = "My Plugin"
description = "Short description (shown in plugin list)"
type = "time-logs"           # Data type (see Plugin Types below)

# Long description for users (shown by `bin/plugins info`)
longDescription = """
Detailed documentation about this plugin, including:
- What data it provides
- How to set it up
- Configuration options explained
"""

# Instructions for the AI on how to query/use this data
aiInstructions = """
Data is available in the `time_logs` table with source = 'my-plugin/{source}'.
Query with: SELECT * FROM time_logs WHERE source LIKE 'my-plugin/%' AND date(start_time) > date('now', '-7 days')
"""

# Commands - paths relative to plugin directory
[commands]
read = "./read.js"           # Reads data, outputs JSON
write = "./write.js"         # Creates/updates entries (optional)

# Configuration options with defaults
# Format: name = { type = "string"|"number"|"boolean", default = value, description = "..." }
# These can be referenced in aiInstructions as {name} placeholders
[settings]
days_to_sync = { type = "number", default = 365 }
directory = { type = "string", default = "vault/logs/time-tracking" }
auto_add_topics = { type = "boolean", default = false, description = "Automatically add topic tags using AI" }
taggable_field = { type = "string", default = "description", description = "Database field to add topic tags to" }

# Encrypted settings for secrets (API keys, passwords, tokens)
# These are stored encrypted in .env and injected at runtime
api_token = { type = "string", default = "", description = "API token", encrypted = true }
```

## Encrypted Settings

For plugins that require secrets (API keys, passwords, tokens), use `encrypted = true` in the setting definition:

```toml
[settings]
api_token = { type = "string", default = "", description = "API token", encrypted = true }
password = { type = "string", default = "", description = "Password", encrypted = true }
```

**How it works:**

1. Users configure secrets via `bin/today configure` or `bin/plugins configure`
2. Values are encrypted and stored in `.env` using dotenvx
3. Environment variable names are auto-generated: `TODAY_<PLUGIN>_<SOURCE>_<SETTING>`
   - Example: `TODAY_IMAP_EMAIL_WORK_PASSWORD` for `imap-email/work` source's `password` setting
4. At runtime, the plugin-loader decrypts and injects values into `PLUGIN_CONFIG`

**In your read/write commands**, access encrypted settings just like regular config:

```javascript
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const apiToken = config.api_token;  // Decrypted value injected by plugin-loader
```

**Benefits:**
- Secrets never stored in plain text
- Unique env var per source (no conflicts between multiple sources)
- Users don't need to manually manage environment variables
- Encryption keys stored separately in `.env.keys`

## Writing a Read Command

The read command reads data and outputs JSON. It can be written in any language.

**Input (environment variables):**
- `PROJECT_ROOT`: Path to the project root
- `PLUGIN_CONFIG`: JSON string of source configuration from config.toml
- `LAST_SYNC_TIME`: ISO timestamp of last sync (empty for first sync)
- `SOURCE_ID`: Full source identifier (e.g., `markdown-time-tracking/local`)
- `CONTEXT_ONLY`: Set to `"true"` when gathering context for AI prompts (see below)

**Output:**
- JSON object to stdout with entries and metadata
- Exit code 0 on success, non-zero on failure
- Error messages to stderr

**Output format:**

```json
{
  "entries": [
    {
      "id": "vault/logs/time-tracking/2025-12.md:5",
      "start_time": "2025-12-15T09:00:00-05:00",
      "end_time": "2025-12-15T10:30:00-05:00",
      "description": "Task description #topic/programming"
    }
  ],
  "files_processed": ["vault/logs/time-tracking/2025-12.md"],
  "incremental": true
}
```

The `id` field should uniquely identify entries and encode location information (e.g., `filepath:lineNum`) for incremental updates.

**Example (Node.js):**

```javascript
#!/usr/bin/env node
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT;
const lastSyncTime = process.env.LAST_SYNC_TIME;

// ... fetch/parse data ...

const entries = [
  {
    id: 'myfile.md:0',
    start_time: '2025-01-15T09:00:00-05:00',
    end_time: '2025-01-15T10:30:00-05:00',
    description: 'Task'
  }
];

console.log(JSON.stringify({
  entries,
  files_processed: ['myfile.md'],
  incremental: !!lastSyncTime
}));
```

## Writing a Write Command

The write command creates or updates entries. It's required for `read-write` plugins.

**Input (environment variables):**
- `PROJECT_ROOT`: Path to the project root
- `PLUGIN_CONFIG`: JSON string of source configuration
- `ENTRY_JSON`: JSON string of the entry to write

**Output:**
- JSON object with `success` boolean and entry details
- Exit code 0 on success, non-zero on failure

**Example entry for starting a timer (no end_time):**

```json
{
  "start_time": "2025-01-15T09:00:00-05:00",
  "end_time": null,
  "description": "Working on feature #topic/programming"
}
```

**Example entry for completing (has end_time):**

```json
{
  "start_time": "2025-01-15T09:00:00-05:00",
  "end_time": "2025-01-15T10:30:00-05:00",
  "description": "Working on feature #topic/programming"
}
```

## The CONTEXT_ONLY Flag

When `bin/today` gathers context for AI prompts, it sets `CONTEXT_ONLY=true` in the environment. This signals plugins to skip expensive operations that aren't needed for reading context.

**What CONTEXT_ONLY affects:**

1. **Data plugins**: The `ensureSyncForType()` function in the plugin loader skips automatic syncing. This prevents slow sync operations when you just want to read cached data.

2. **Context plugins**: Should skip:
   - AI API calls (summaries, suggestions, analysis)
   - Subprocess spawning (e.g., calling `bin/today` recursively)
   - File modifications (creating/updating files)

**When to check CONTEXT_ONLY in your plugin:**

```javascript
const contextOnly = process.env.CONTEXT_ONLY === 'true';

// Skip expensive AI operations during context gathering
if (!contextOnly) {
  const summary = await generateAISummary(data);
  await writeToFile(summaryPath, summary);
}

// Always return the current context data
console.log(JSON.stringify({ context, metadata }));
```

**Example - markdown-plans plugin:**

The markdown-plans plugin generates AI summaries for past days and suggestions for tomorrow. These operations are skipped when `CONTEXT_ONLY=true` because:
- They call AI APIs (slow, costs money)
- They spawn `bin/today dry-run` subprocesses
- The summaries aren't needed just to display current plan context

**When NOT to use CONTEXT_ONLY:**

- Read-only HTTP fetches (like weather API) - these are fast and stateless
- Simple file reads and local calculations
- Operations that don't modify files or call AI

The goal is fast context gathering (~5-10 seconds) for responsive AI sessions.

## Plugin Types

Each plugin type has a defined schema. Data is stored in a shared table for that type. [plugin-schemas.js](/src/plugin-schemas.js) is the source of schema truth.

| Type | Table | Description |
|------|-------|-------------|
| `context` | *(none)* | Ephemeral AI context (weather, plans, day themes) |
| `diary` | `diary` | Journal entries with date and text |
| `email` | `email` | Email messages with headers and content |
| `events` | `events` | Calendar events with start/end times |
| `habits` | `habits` | Daily habit tracking with completion status |
| `health` | `health_metrics` | Health measurements (steps, weight, sleep) |
| `issues` | `issues` | Tickets, bugs, alerts from external systems |
| `projects` | `projects` | Project tracking with status and progress |
| `tasks` | `tasks` | To-do items with priority and due dates |
| `time-logs` | `time_logs` | Time tracking entries with start/end times |
| `utility` | *(none)* | Maintenance tasks (cleanup, linting) |

### Example: time-logs

Duration-based activity records for time tracking.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| start_time | string | ISO 8601 datetime with timezone |

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier (recommended: `filepath:lineNum`) |
| end_time | string | ISO 8601 datetime (null if timer running) |
| duration_minutes | number | Computed from start/end times |
| description | string | Activity description |

See `src/plugin-schemas.js` for complete schema definitions for all types.

## Plugin Vault Files

Plugins can include files that belong in the user's vault—templates, Dataview scripts, dashboards, etc. These are stored in a `vault/` subdirectory within each plugin.

### Structure

```
plugins/
  markdown-plans/
    plugin.toml
    read.js
    vault/                # Files to copy to user's vault
      templates/
        daily-plan.md
        weekly-review.md
      scripts/
        weekly-header.js
      plans/              # Creates empty directory
        .gitkeep
```

The file paths within `vault/` mirror where they should appear in the user's vault. For example, `plugins/markdown-plans/vault/templates/daily-plan.md` installs to `{vault_path}/templates/daily-plan.md`.

### Managing Vault Files

```bash
# Check for new/updated vault files from enabled plugins
bin/plugins vault-files --check

# Install missing vault files (won't overwrite existing)
bin/plugins vault-files --install

# Force update all vault files (overwrites existing)
bin/plugins vault-files --install --force

# List all vault files from enabled plugins
bin/plugins vault-files --list
```

### Automatic Updates

When you run `bin/today update`, the system automatically checks for vault file updates after applying the git update. If any enabled plugins have new or modified vault files, you'll see a notification.

Additionally, `bin/today` performs a daily check for vault file updates and notifies you if any are available.

### For Plugin Authors

To include vault files in your plugin:

1. Create a `vault/` directory in your plugin folder
2. Add files with paths matching their destination in the user's vault
3. Use `.gitkeep` files to create empty directories (these are skipped during install)

Files are only copied if:
- They don't already exist in the user's vault (default behavior)
- The user runs `--install --force` to overwrite

This ensures users' customizations are preserved while still allowing them to get updates when desired.

## CLI Commands

```bash
bin/plugins list                    # Show available plugins
bin/plugins info <plugin>           # Show detailed plugin documentation
bin/plugins status                  # Show enabled plugins and their sources
bin/plugins configure               # Interactive configuration
bin/plugins configure <plugin>      # Configure specific plugin
bin/plugins sync                    # Sync all enabled plugins
bin/plugins sync <plugin>           # Sync specific plugin
bin/plugins sync --type <type>      # Sync plugins of a specific type
bin/plugins vault-files             # Check for vault file updates
bin/plugins vault-files --install   # Install missing vault files
```

### Interactive Configuration

Run `bin/plugins configure` to open a full-screen configuration UI:

- Use arrow keys to navigate the plugin list
- Press Enter to select a plugin and view/edit its sources
- Press Escape to go back
- Press `a` to add a new source, `d` to delete

When editing a source, you can toggle settings, edit values inline, and open multi-line fields (like AI instructions) in your `$EDITOR`.

## Creating a New Plugin

1. Create directory: `mkdir plugins/my-plugin`
2. Create `plugins/my-plugin/plugin.toml` with metadata
3. Create read command (e.g., `plugins/my-plugin/read.js`)
4. Optionally create write command for read-write plugins
5. Make scripts executable: `chmod +x plugins/my-plugin/*.js`
6. Run `bin/plugins list` to verify discovery
7. Add configuration to `config.toml` with `enabled = true`
8. Run `bin/plugins sync my-plugin` to test
