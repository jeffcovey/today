// Schema definitions for plugin types
// Used to validate plugin output and document expected fields

export const schemas = {
  'time-entries': {
    required: ['start_time', 'description'],
    optional: ['end_time', 'duration_minutes', 'topics'],
    fields: {
      start_time: { type: 'string', description: 'ISO 8601 datetime with timezone' },
      end_time: { type: 'string', description: 'ISO 8601 datetime (null if timer running)' },
      duration_minutes: { type: 'number', description: 'Duration in minutes (computed from start/end)' },
      description: { type: 'string', description: 'Activity description, may contain #topic/ tags' },
      topics: { type: 'string', description: 'Extracted topic tags (e.g., #topic/programming)' }
    }
  }
  // Add other types here as we implement them
};

/**
 * Validate an array of entries against a schema
 * @param {string} pluginType - The plugin type (e.g., 'time-entries')
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

  const allFields = new Set([...schema.required, ...schema.optional]);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryLabel = `Entry ${i + 1}`;

    // Check required fields
    for (const field of schema.required) {
      if (entry[field] === undefined || entry[field] === null) {
        result.valid = false;
        result.errors.push(`${entryLabel}: Missing required field '${field}'`);
      } else {
        // Type check
        const expectedType = schema.fields[field]?.type;
        const actualType = typeof entry[field];
        if (expectedType && actualType !== expectedType) {
          result.valid = false;
          result.errors.push(`${entryLabel}: Field '${field}' should be ${expectedType}, got ${actualType}`);
        }
      }
    }

    // Check optional field types
    for (const field of schema.optional) {
      if (entry[field] !== undefined && entry[field] !== null) {
        const expectedType = schema.fields[field]?.type;
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
  return schemas[pluginType] || null;
}

/**
 * Get all defined plugin types
 * @returns {string[]}
 */
export function getPluginTypes() {
  return Object.keys(schemas);
}
