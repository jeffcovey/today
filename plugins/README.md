# Plugins

Plugins integrate external data sources with the Today system. Each plugin syncs data to a local SQLite table where it can be queried and displayed.

## Directory Structure

```
plugins/
  time-tracking/
    plugin.toml      # Plugin metadata
    sync.js          # Sync command (can be any executable)
```

## Configuration

Plugins are configured in `config.toml`:

```toml
[plugins.time-tracking.local]
enabled = true
days_to_sync = 365
directory = "vault/logs/time-tracking"
ai_instructions = """
This tracks my personal time entries. Focus on productivity patterns
and highlight any days with unusually low or high activity.
"""
```

Each section follows the pattern `[plugins.<plugin-name>.<source-name>]`:
- `plugin-name`: The plugin's `name` from plugin.toml (e.g., `time-tracking`)
- `source-name`: Your label for this instance (e.g., `local`, `work`, `personal`)

Multiple sources create separate database tables, avoiding conflicts.

### AI Instructions

The optional `ai_instructions` field lets you provide context to the AI about how to interpret and use this data source. This is included in the prompt when running `bin/today` sessions.

Use TOML multi-line strings (triple quotes) for longer instructions:

```toml
ai_instructions = """
This is my work time tracking. When reviewing:
- Prioritize entries tagged with #topic/urgent
- Highlight any meetings that ran over 1 hour
- Note patterns in my most productive hours
"""
```

## plugin.toml Format

```toml
# Plugin metadata
name = "my-plugin"
displayName = "My Plugin"
description = "What this plugin does"
type = "time-entries"        # Data type (see Plugin Types below)
access = "read-write"        # read-only, write-only, or read-write

# Environment variables required to run
requiredEnv = ["API_TOKEN"]

# Commands - paths relative to plugin directory
[commands]
sync = "./sync.js"           # Can be .js, .sh, .py, or any executable

# Configuration options with defaults
[configSchema]
days_to_sync = { type = "number", default = 365 }
directory = { type = "string", default = "vault/logs/time-tracking" }
```

## Writing a Sync Command

The sync command can be written in any language. It receives:

**Input:**
- `PROJECT_ROOT` env var: Path to the project root
- `PLUGIN_CONFIG` env var: JSON string of source configuration from config.toml

**Output:**
- JSON array of entries to stdout
- Exit code 0 on success, non-zero on failure
- Error messages to stderr

**Example (Node.js):**

```javascript
#!/usr/bin/env node
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT;

// ... fetch/parse data ...

const entries = [
  { start_time: '2025-01-15T09:00:00-05:00', end_time: '2025-01-15T10:30:00-05:00', description: 'Task' }
];

console.log(JSON.stringify(entries));
```

**Example (Bash):**

```bash
#!/bin/bash
curl -s "https://api.example.com/entries" | jq '[.[] | {start_time, end_time, description}]'
```

## Plugin Types

### time-entries

Duration-based activity records for time tracking.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| start_time | string | ISO 8601 datetime with timezone |
| description | string | Activity description |

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| end_time | string | ISO 8601 datetime (null if timer running) |
| duration_minutes | number | Computed from start/end times |
| topics | string | Extracted topic tags (e.g., `#topic/programming`) |

## CLI Commands

```bash
bin/plugins list              # Show available plugins
bin/plugins status            # Show enabled plugins and their sources
bin/plugins configure         # Interactive configuration
bin/plugins configure <plugin>  # Configure specific plugin
bin/plugins sync              # Sync all enabled plugins
bin/plugins sync <plugin>     # Sync specific plugin
bin/plugins sync <plugin> <source>  # Sync specific source
```

### Interactive Configuration

Run `bin/plugins configure` to interactively manage plugin sources:

```
? Select a plugin to configure: Time Tracking
? What would you like to do?
  1) Add new source
  2) Edit source
  3) Remove source
  4) Back
```

When editing a source, you can:
- Enable/disable the source
- Edit plugin-specific settings (e.g., `days_to_sync`, `directory`)
- Add or edit AI instructions (opens in `$EDITOR`)

## Creating a New Plugin

1. Create directory: `mkdir plugins/my-plugin`
2. Create `plugins/my-plugin/plugin.toml` with metadata
3. Create sync command (e.g., `plugins/my-plugin/sync.sh`)
4. Make it executable: `chmod +x plugins/my-plugin/sync.sh`
5. Run `bin/plugins list` to verify discovery
6. Add configuration to `config.toml` with `enabled = true`
7. Run `bin/plugins sync my-plugin` to test
