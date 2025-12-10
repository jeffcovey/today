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
  }
  // Add other plugin types here as we implement them:
  // 'habits': { table: 'habits', fields: {...}, indexes: [...] },
  // 'events': { table: 'events', fields: {...}, indexes: [...] },
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
