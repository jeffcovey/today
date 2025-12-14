// Single source of truth for plugin type schemas
// Used for both database migrations and plugin output validation

/**
 * Plugin type schema definitions
 *
 * Each field can have:
 * - sqlType: SQL column definition (required for DB fields)
 * - jsType: JavaScript type for validation ('string', 'number', 'boolean')
 * - required: Whether plugin must provide this field (default: false)
 * - dbOnly: Field is added by the system, not provided by plugins (default: false)
 * - description: Human-readable description
 */
export const schemas = {
  'time-logs': {
    table: 'time_logs',
    staleMinutes: 0, // Always sync - timers can start/stop any moment
    ai: {
      name: 'Time Tracking',
      description: `Time logs record when a user began and ended an activity.
They reflect what the user *actually did*, and are more
determinative than lists of what was planned for a given
time or whether or not a task has been checked off.
They should be considered the truth of what was done.`,
      defaultCommand: 'bin/track today',
      queryInstructions: `Commands: bin/track today, bin/track week, bin/track status, bin/track start "desc", bin/track stop
SQL: SELECT * FROM time_logs WHERE DATE(start_time) = DATE('now', 'localtime') ORDER BY start_time DESC`
    },
    fields: {
      id: {
        sqlType: 'TEXT PRIMARY KEY',
        jsType: 'string',
        required: false,
        description: 'Unique identifier (generated if not provided)'
      },
      source: {
        sqlType: 'TEXT NOT NULL',
        dbOnly: true,
        description: 'Plugin source identifier (e.g., markdown-time-tracking/local)'
      },
      start_time: {
        sqlType: 'DATETIME NOT NULL',
        jsType: 'string',
        required: true,
        description: 'ISO 8601 datetime with timezone'
      },
      end_time: {
        sqlType: 'DATETIME',
        jsType: 'string',
        required: false,
        description: 'ISO 8601 datetime (null if timer running)'
      },
      duration_minutes: {
        sqlType: 'INTEGER',
        jsType: 'number',
        required: false,
        description: 'Duration in minutes (computed from start/end)'
      },
      description: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Activity description'
      },
      created_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record creation timestamp'
      },
      updated_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record update timestamp'
      }
    },
    indexes: ['source', 'start_time']
  },

  'diary': {
    table: 'diary',
    staleMinutes: 60, // Diary entries don't change often
    ai: {
      name: 'Diary / Journal',
      description: `Diaries are journals capturing thoughts, experiences, and reflections.
They may be personal or for work purposes, and may have many uses —
goal tracking, end-of-day summaries, mental wellness, etc. Use them
for understanding the user's mood, context, and personal history.

"On this day" queries show entries from the same date in previous
years. They may be of nostalgic interest to the user, or may prompt
a connection with current circumstances.

Some diary sources include metadata with an entry's location,
weather, associated photos, tags, etc.`,
      defaultCommand: 'bin/diary today ;bin/diary on-this-day',
      queryInstructions: `Commands: bin/diary today, bin/diary week, bin/diary search "term", bin/diary on-this-day, bin/diary stats
SQL: SELECT DATE(date) as day, SUBSTR(text, 1, 200) as preview FROM diary ORDER BY date DESC LIMIT 10`
    },
    fields: {
      id: {
        sqlType: 'TEXT PRIMARY KEY',
        jsType: 'string',
        required: false,
        description: 'Unique identifier (generated if not provided)'
      },
      source: {
        sqlType: 'TEXT NOT NULL',
        dbOnly: true,
        description: 'Plugin source identifier (e.g., dayone-diary/default)'
      },
      date: {
        sqlType: 'DATETIME NOT NULL',
        jsType: 'string',
        required: true,
        description: 'When the entry was written (ISO 8601)'
      },
      text: {
        sqlType: 'TEXT NOT NULL',
        jsType: 'string',
        required: true,
        description: 'The diary entry content'
      },
      metadata: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'JSON blob for source-specific data (location, weather, starred, tags, etc.)'
      },
      created_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record creation timestamp'
      },
      updated_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record update timestamp'
      }
    },
    indexes: ['source', 'date']
  },

  'issues': {
    table: 'issues',
    staleMinutes: 10, // Issues don't change as frequently
    ai: {
      name: 'Issues & Tickets',
      description: `Issues are bugs, feature requests, and support tickets from external
systems like Zendesk, GitHub, Sentry, Front, etc.
- Each source tracks a different project or system
- State is 'open' or 'closed'
- Metadata contains source-specific details (labels, assignees, error counts, etc.)`,
      defaultCommand: 'bin/issues open',
      queryInstructions: `Commands: bin/issues open, bin/issues show <id>, bin/issues open --source github-issues
SQL: SELECT source, title, state, opened_at FROM issues WHERE state = 'open' ORDER BY opened_at DESC`
    },
    fields: {
      id: {
        sqlType: 'TEXT PRIMARY KEY',
        jsType: 'string',
        required: true,
        description: 'Unique identifier (issue number, key like PROJ-123, etc.)'
      },
      source: {
        sqlType: 'TEXT NOT NULL',
        dbOnly: true,
        description: 'Plugin source identifier (e.g., github-issues/today)'
      },
      title: {
        sqlType: 'TEXT NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Issue title'
      },
      state: {
        sqlType: 'TEXT NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Issue state (open, closed)'
      },
      opened_at: {
        sqlType: 'DATETIME NOT NULL',
        jsType: 'string',
        required: true,
        description: 'When the issue was opened (ISO 8601)'
      },
      url: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'URL to the issue'
      },
      body: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Issue description/body'
      },
      metadata: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'JSON blob for source-specific data (labels, assignees, milestone, closed_at, etc.)'
      },
      created_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Database record creation timestamp'
      },
      updated_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Database record update timestamp'
      }
    },
    indexes: ['source', 'state', 'opened_at']
  },

  'context': {
    // Context plugins don't store data in a database table
    // They run commands and return ephemeral output for AI context
    table: null,
    staleMinutes: 0, // Always fresh - context is ephemeral
    ai: {
      name: 'Contextual Information',
      description: `"context" is real-time contextual data from various sources.
Plugins of this type may provide any sort of data the user
wants to keep track of. Examples:
- Files changed or added today in the vault
- Other dynamic context that doesn't require persistent storage`,
      defaultCommand: 'bin/context show',
      queryInstructions: `Context plugins provide ephemeral data that doesn't persist in the database.
These plugins do not save to the database.`
    },
    fields: {}
  },

  'events': {
    table: 'events',
    staleMinutes: 5, // Calendar events change occasionally
    ai: {
      name: 'Calendar Events',
      description: `Events may be synced from many sources. Try to distinguish between
the user's personal events and calendars that just suggest events of
possible interest. Use calendar data to understand the user's schedule
and availability, and to look for timing conflicts and anything that needs
preparation.`,
      defaultCommand: 'bin/calendar today ; bin/calendar week',
      queryInstructions: `Commands: bin/calendar today, bin/calendar week, bin/calendar sync
SQL: SELECT title, start_date, end_date, location FROM events WHERE DATE(start_date) >= DATE('now') ORDER BY start_date LIMIT 20

Note: Only recent events are synced to the database. For historical events,
use: bin/calendar show <source> <date> (e.g., bin/calendar show personal 2023-01-15)
Run 'bin/calendar list' to see available sources.`
    },
    fields: {
      id: {
        sqlType: 'TEXT PRIMARY KEY',
        jsType: 'string',
        required: true,
        description: 'Unique event identifier'
      },
      source: {
        sqlType: 'TEXT NOT NULL',
        dbOnly: true,
        description: 'Plugin source identifier (e.g., public-calendars/tripit)'
      },
      calendar_name: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Name of the calendar this event belongs to'
      },
      title: {
        sqlType: 'TEXT NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Event title/summary'
      },
      start_date: {
        sqlType: 'DATETIME NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Event start time (ISO 8601)'
      },
      end_date: {
        sqlType: 'DATETIME NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Event end time (ISO 8601)'
      },
      start_timezone: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Timezone for start time (e.g., America/New_York)'
      },
      end_timezone: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Timezone for end time'
      },
      location: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Event location'
      },
      description: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Event description/notes'
      },
      all_day: {
        sqlType: 'BOOLEAN DEFAULT 0',
        jsType: 'boolean',
        required: false,
        description: 'Whether this is an all-day event'
      },
      created_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record creation timestamp'
      },
      updated_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record update timestamp'
      }
    },
    indexes: ['source', 'start_date', 'end_date']
  },

  'tasks': {
    table: 'tasks',
    staleMinutes: 5, // Tasks change moderately often
    ai: {
      name: 'Tasks',
      description: `Tasks are to-do items from various sources (Obsidian markdown, Todoist, Asana, etc.).
Each task has a status (open or completed), optional priority, and optional due date.
Source-specific fields like project, tags, recurrence, and assignee are in metadata.`,
      defaultCommand: 'bin/tasks today ; bin/tasks recent -d 2',
      queryInstructions: `Commands: bin/tasks list, bin/tasks today, bin/tasks add "task", bin/tasks complete "id" --title "title"
SQL: SELECT id, title, priority, due_date FROM tasks WHERE status = 'open'`
    },
    fields: {
      id: {
        sqlType: 'TEXT PRIMARY KEY',
        jsType: 'string',
        required: true,
        description: 'Unique identifier (e.g., file:line or external system ID)'
      },
      source: {
        sqlType: 'TEXT NOT NULL',
        dbOnly: true,
        description: 'Plugin source identifier (e.g., markdown-tasks/local)'
      },
      title: {
        sqlType: 'TEXT NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Task title/description'
      },
      status: {
        sqlType: 'TEXT NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Task status: open or completed'
      },
      priority: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Priority level: highest, high, medium, low, lowest'
      },
      due_date: {
        sqlType: 'DATE',
        jsType: 'string',
        required: false,
        description: 'Due date (YYYY-MM-DD)'
      },
      completed_at: {
        sqlType: 'DATETIME',
        jsType: 'string',
        required: false,
        description: 'When the task was completed (ISO 8601)'
      },
      description: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Extended notes/body text'
      },
      metadata: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'JSON blob for source-specific data (tags, project, assignee, recurrence, stage, topics, etc.)'
      },
      created_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record creation timestamp'
      },
      updated_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record update timestamp'
      }
    },
    indexes: ['source', 'status', 'due_date', 'priority']
  },

  'habits': {
    table: 'habits',
    staleMinutes: 30, // Habits sync from backup files, don't need frequent updates
    ai: {
      name: 'Habits',
      description: `Habits are routines the user is trying to build or maintain.
They may be something the user wants to do or wants to avoid.
Each entry represents one habit on one day,
with completion status and optional quantitative value.
Use habit_id to group entries for the same habit across days.`,
      defaultCommand: 'bin/habits streaks ; bin/habits today',
      queryInstructions: `Commands: bin/habits today, bin/habits list, bin/habits streaks
SQL: SELECT title, date, status, value FROM habits WHERE date = date('now') ORDER BY title`
    },
    fields: {
      id: {
        sqlType: 'TEXT PRIMARY KEY',
        jsType: 'string',
        required: true,
        description: 'Unique identifier (source:habit_uuid:date)'
      },
      source: {
        sqlType: 'TEXT NOT NULL',
        dbOnly: true,
        description: 'Plugin source identifier (e.g., streaks-habits/default)'
      },
      habit_id: {
        sqlType: 'TEXT NOT NULL',
        jsType: 'string',
        required: true,
        description: 'The habit UUID, for grouping entries across days'
      },
      title: {
        sqlType: 'TEXT NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Habit name'
      },
      date: {
        sqlType: 'DATE NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Date of this entry (YYYY-MM-DD)'
      },
      status: {
        sqlType: 'TEXT NOT NULL',
        jsType: 'string',
        required: true,
        description: 'Status for this day: completed, pending, skipped, partial'
      },
      goal_type: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Goal type: achieve (do more), limit (stay under), or null (boolean)'
      },
      value: {
        sqlType: 'REAL',
        jsType: 'number',
        required: false,
        description: 'Achieved value (duration in seconds, count, etc.)'
      },
      category: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'Category/group name'
      },
      metadata: {
        sqlType: 'TEXT',
        jsType: 'string',
        required: false,
        description: 'JSON blob for source-specific data (icon, target, streak_at_date, etc.)'
      },
      created_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record creation timestamp'
      },
      updated_at: {
        sqlType: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        dbOnly: true,
        description: 'Record update timestamp'
      }
    },
    indexes: ['source', 'habit_id', 'date', 'status']
  }

  // NOTE: Add new plugin types HERE (at the end) to get correct migration version numbers
};

/**
 * Generate SQL column definitions from schema
 * @param {string} pluginType
 * @returns {string} SQL column definitions
 */
export function getSqlColumns(pluginType) {
  const schema = schemas[pluginType];
  if (!schema) return null;

  return Object.entries(schema.fields)
    .map(([name, field]) => `${name} ${field.sqlType}`)
    .join(',\n      ');
}

/**
 * Get table name for a plugin type
 * @param {string} pluginType
 * @returns {string|null}
 */
export function getTableName(pluginType) {
  return schemas[pluginType]?.table || null;
}

/**
 * Get indexes for a plugin type
 * @param {string} pluginType
 * @returns {string[]}
 */
export function getIndexes(pluginType) {
  return schemas[pluginType]?.indexes || [];
}

/**
 * Validate an array of entries against a schema
 * @param {string} pluginType - The plugin type (e.g., 'time-logs')
 * @param {Array} entries - Array of entries from plugin sync
 * @param {object} options - { logger: console, pluginName: string }
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateEntries(pluginType, entries, options = {}) {
  const { logger = console, pluginName = 'unknown' } = options;
  const schema = schemas[pluginType];

  const result = {
    valid: true,
    errors: [],
    warnings: []
  };

  if (!schema) {
    result.warnings.push(`No schema defined for plugin type '${pluginType}'`);
    return result;
  }

  // Build required/optional field lists from schema (excluding dbOnly fields)
  const requiredFields = [];
  const optionalFields = [];
  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.dbOnly) continue;
    if (field.required) {
      requiredFields.push(name);
    } else {
      optionalFields.push(name);
    }
  }

  const allFields = new Set([...requiredFields, ...optionalFields]);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryLabel = `Entry ${i + 1}`;

    // Check required fields
    for (const field of requiredFields) {
      if (entry[field] === undefined || entry[field] === null) {
        result.valid = false;
        result.errors.push(`${entryLabel}: Missing required field '${field}'`);
      } else {
        // Type check
        const expectedType = schema.fields[field]?.jsType;
        const actualType = typeof entry[field];
        if (expectedType && actualType !== expectedType) {
          result.valid = false;
          result.errors.push(`${entryLabel}: Field '${field}' should be ${expectedType}, got ${actualType}`);
        }
      }
    }

    // Check optional field types
    for (const field of optionalFields) {
      if (entry[field] !== undefined && entry[field] !== null) {
        const expectedType = schema.fields[field]?.jsType;
        const actualType = typeof entry[field];
        if (expectedType && actualType !== expectedType) {
          result.warnings.push(`${entryLabel}: Field '${field}' should be ${expectedType}, got ${actualType}`);
        }
      }
    }

    // Check for unknown fields
    for (const field of Object.keys(entry)) {
      if (!allFields.has(field)) {
        result.warnings.push(`${entryLabel}: Unknown field '${field}'`);
      }
    }
  }

  // Log errors and warnings
  if (result.errors.length > 0) {
    logger.error(`Plugin ${pluginName} validation errors:`);
    for (const error of result.errors.slice(0, 5)) {
      logger.error(`  - ${error}`);
    }
    if (result.errors.length > 5) {
      logger.error(`  ... and ${result.errors.length - 5} more errors`);
    }
  }

  if (result.warnings.length > 0) {
    logger.warn(`Plugin ${pluginName} validation warnings:`);
    for (const warning of result.warnings.slice(0, 5)) {
      logger.warn(`  - ${warning}`);
    }
    if (result.warnings.length > 5) {
      logger.warn(`  ... and ${result.warnings.length - 5} more warnings`);
    }
  }

  return result;
}

/**
 * Get schema for a plugin type
 * @param {string} pluginType
 * @returns {object|null}
 */
export function getSchema(pluginType) {
  const schema = schemas[pluginType];
  if (!schema) return null;

  // Return in the old format for backwards compatibility with tests
  const required = [];
  const optional = [];
  const fields = {};

  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.dbOnly) continue;

    fields[name] = {
      type: field.jsType,
      description: field.description
    };

    if (field.required) {
      required.push(name);
    } else {
      optional.push(name);
    }
  }

  return { table: schema.table, required, optional, fields };
}

/**
 * Get all defined plugin types
 * @returns {string[]}
 */
export function getPluginTypes() {
  return Object.keys(schemas);
}

/**
 * Get AI metadata for a plugin type
 * @param {string} pluginType
 * @returns {object|null} { name, description, defaultCommand, queryInstructions }
 */
export function getAIMetadata(pluginType) {
  return schemas[pluginType]?.ai || null;
}

/**
 * Stale thresholds for plugin types not yet in full schema
 * These will be moved into schemas when full schema support is added
 */
const staleMinutesByType = {
  'habits': 30,         // Habits sync daily, don't need frequent updates
  'health-metrics': 60, // Health data syncs periodically from phone
  'utility': 0,         // Utility plugins run on-demand, always fresh
};

/**
 * Get stale threshold for a plugin type
 * @param {string} pluginType
 * @returns {number} Minutes before data is considered stale (default: 5)
 */
export function getStaleMinutes(pluginType) {
  // Check full schema first
  if (schemas[pluginType]?.staleMinutes !== undefined) {
    return schemas[pluginType].staleMinutes;
  }
  // Check fallback table for types without full schemas
  if (staleMinutesByType[pluginType] !== undefined) {
    return staleMinutesByType[pluginType];
  }
  // Default for unknown types
  return 5;
}

/**
 * Generate AI context block for a plugin type
 * Includes description, schema, query instructions, and user instructions
 *
 * @param {string} pluginType - The plugin type (e.g., 'time-logs')
 * @param {object} options
 * @param {Array<{sourceId: string, text: string}>} options.userInstructions - User's custom AI instructions
 * @param {string} options.currentData - Output from running the default command
 * @returns {string} Formatted context block for AI prompt
 */
export function generateAIContextBlock(pluginType, options = {}) {
  const schema = schemas[pluginType];
  if (!schema || !schema.ai) return '';

  const { userInstructions = [], currentData } = options;
  const { name, description, defaultCommand, queryInstructions } = schema.ai;

  const lines = [];

  // Header
  lines.push(`## SOURCE: ${name}`);
  lines.push('');

  // Description
  lines.push(description);
  lines.push('');

  // Query instructions
  lines.push('**To investigate further:**');
  lines.push(queryInstructions);
  lines.push('');

  // Schema for direct SQL queries (skip for utility plugins which have no table)
  if (schema.table && Object.keys(schema.fields).length > 0) {
    lines.push('**Database schema:**');
    lines.push('```sql');
    lines.push(`-- Table: ${schema.table}`);
    for (const [fieldName, field] of Object.entries(schema.fields)) {
      const nullable = field.sqlType.includes('NOT NULL') ? '' : ' (nullable)';
      lines.push(`-- ${fieldName}: ${field.description}${nullable}`);
    }
    lines.push('```');
    lines.push('');
  }

  // User instructions (if any)
  if (userInstructions && userInstructions.length > 0) {
    lines.push('**Specific instructions from the user:**');
    for (const { sourceId, text } of userInstructions) {
      lines.push(`From ${sourceId}:`);
      lines.push(`> ${text.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }
  }

  // Current data
  if (currentData) {
    lines.push(`**Current data** (from \`${defaultCommand}\`):`);
    lines.push('```');
    lines.push(currentData.trim());
    lines.push('```');
  }

  return lines.join('\n');
}
