// Auto-tagger - adds topic tags to text fields using AI
// This is a generic feature that any read-write plugin can use.
//
// Flow:
// 1. Query DB for entries missing #topic/ in the taggable field
// 2. Get available topics from config + entries that have them
// 3. Use AI to suggest tags for untagged entries
// 4. Call plugin's update command to modify entries
// 5. Failures are logged but never block sync

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getFullConfig } from './config.js';

/**
 * Check if Anthropic API is available via environment variable
 */
function isAIAvailable() {
  try {
    const apiKey = execSync('npx dotenvx get TODAY_ANTHROPIC_KEY 2>/dev/null || npx dotenvx get ANTHROPIC_API_KEY 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return apiKey.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get configured topics from config.toml [tags] section
 * @returns {string[]} - Array of configured topic names
 */
function getConfiguredTopics() {
  try {
    const config = getFullConfig();
    return config.tags?.topics || [];
  } catch {
    return [];
  }
}

/**
 * Get available topics from config and database entries
 * Combines user-configured topics with those discovered in existing data
 * @param {object} db - Database connection
 * @param {string} tableName - Table to query
 * @param {string} field - Field containing topics
 * @param {string} sourceId - Source identifier
 * @returns {string[]} - Array of topic names
 */
function getAvailableTopics(db, tableName, field, sourceId) {
  const topicSet = new Set();

  // Add configured topics first
  const configuredTopics = getConfiguredTopics();
  for (const topic of configuredTopics) {
    topicSet.add(topic);
  }

  // Add topics discovered in database
  try {
    const rows = db.prepare(`
      SELECT DISTINCT ${field}
      FROM ${tableName}
      WHERE source = ?
        AND ${field} LIKE '%#topic/%'
    `).all(sourceId);

    for (const row of rows) {
      const text = row[field];
      if (!text) continue;

      const matches = text.match(/#topic\/[a-z_]+/g);
      if (matches) {
        for (const match of matches) {
          topicSet.add(match.replace('#topic/', ''));
        }
      }
    }
  } catch (error) {
    console.warn(`Warning: Failed to get topics from database: ${error.message}`);
  }

  return Array.from(topicSet).sort();
}

/**
 * Get entries that need tagging
 * @param {object} db - Database connection
 * @param {string} tableName - Table to query
 * @param {string} field - Field to check for topics
 * @param {string} sourceId - Source identifier
 * @returns {Array} - Entries needing tags
 */
function getUntaggedEntries(db, tableName, field, sourceId) {
  try {
    return db.prepare(`
      SELECT id, ${field}
      FROM ${tableName}
      WHERE source = ?
        AND ${field} NOT LIKE '%#topic/%'
        AND ${field} IS NOT NULL
        AND ${field} != ''
    `).all(sourceId);
  } catch (error) {
    console.warn(`Warning: Failed to query untagged entries: ${error.message}`);
    return [];
  }
}

/**
 * Use AI to suggest topics for entries
 * @param {Array} entries - Entries to tag
 * @param {string[]} availableTopics - Topics to choose from
 * @param {string} field - Field name containing text
 * @returns {Map<string, string>} - Map of entry ID to suggested topic
 */
function suggestTopics(entries, availableTopics, field) {
  const suggestions = new Map();
  const BATCH_SIZE = 30;

  // Get model from config or use default
  let model = 'claude-haiku-4-5-20251001';
  try {
    const configModel = execSync('bin/get-config ai.claude_model 2>/dev/null', { encoding: 'utf8' }).trim();
    if (configModel) model = configModel;
  } catch { /* use default */ }
  if (process.env.CLAUDE_MODEL) model = process.env.CLAUDE_MODEL;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, Math.min(i + BATCH_SIZE, entries.length));

    const prompt = `Analyze these entries and suggest 1 relevant topic for each from the available list.

Available topics: ${availableTopics.join(', ')}

For each entry, choose the most relevant topic based on the text.

Respond with a JSON array where each has:
{"index": entry_index, "topic": "topic_name"}

If no topics clearly apply, use an empty string for topic.
Only use topics from the available list.

Entries:
${JSON.stringify(batch.map((e, idx) => ({ index: idx, text: e[field] })), null, 2)}`;

    try {
      // Use Anthropic API directly instead of claude CLI to avoid cluttering history
      const tempPromptFile = `/tmp/auto-tagger-prompt-${Date.now()}.txt`;
      fs.writeFileSync(tempPromptFile, prompt);

      const result = execSync(
        `npx dotenvx run --quiet -- node -e "const Anthropic = require('@anthropic-ai/sdk'); const fs = require('fs'); const client = new Anthropic({ apiKey: process.env.TODAY_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY }); (async () => { const prompt = fs.readFileSync('${tempPromptFile}', 'utf-8'); const response = await client.messages.create({ model: '${model}', max_tokens: 1000, temperature: 0, messages: [{ role: 'user', content: prompt }] }); console.log(response.content[0].text.trim()); })();"`,
        { encoding: 'utf8', timeout: 60000 }
      );

      fs.unlinkSync(tempPromptFile);

      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const classifications = JSON.parse(jsonMatch[0]);

        for (const cls of classifications) {
          if (cls.topic && availableTopics.includes(cls.topic)) {
            const entry = batch[cls.index];
            if (entry) {
              suggestions.set(entry.id, cls.topic);
            }
          }
        }
      }
    } catch (error) {
      // Log but continue - don't fail the whole operation
      console.warn(`Warning: AI tagging batch failed: ${error.message}`);
    }
  }

  return suggestions;
}

/**
 * Run auto-tagging for a plugin source after sync
 * @param {object} options
 * @param {object} options.db - Database connection
 * @param {object} options.plugin - Plugin metadata
 * @param {string} options.sourceName - Source name
 * @param {object} options.sourceConfig - Source configuration
 * @param {string} options.tableName - Database table name
 * @param {string} options.taggableField - Field to tag (e.g., 'description')
 * @param {function} options.updateEntry - Function to update an entry: (id, newFieldValue) => Promise<boolean>
 * @returns {Promise<{tagged: number, failed: number, skipped: number}>}
 */
export async function runAutoTagger(options) {
  const { db, plugin, sourceName, sourceConfig, tableName, taggableField, updateEntry } = options;
  const sourceId = `${plugin.name}/${sourceName}`;

  const result = { tagged: 0, failed: 0, skipped: 0 };

  // Check if auto_add_topics is enabled
  if (!sourceConfig.auto_add_topics) {
    return result;
  }

  // Check if AI is available
  if (!isAIAvailable()) {
    console.warn('Warning: Anthropic API key not found - skipping auto-tagging');
    return result;
  }

  // Get available topics
  const availableTopics = getAvailableTopics(db, tableName, taggableField, sourceId);
  if (availableTopics.length === 0) {
    // No existing topics to use as reference
    return result;
  }

  // Get untagged entries
  const untaggedEntries = getUntaggedEntries(db, tableName, taggableField, sourceId);
  if (untaggedEntries.length === 0) {
    return result;
  }

  // Get AI suggestions
  const suggestions = suggestTopics(untaggedEntries, availableTopics, taggableField);
  if (suggestions.size === 0) {
    result.skipped = untaggedEntries.length;
    return result;
  }

  // Update entries with suggested topics
  for (const entry of untaggedEntries) {
    const topic = suggestions.get(entry.id);
    if (!topic) {
      result.skipped++;
      continue;
    }

    // Append topic to the field value
    const currentValue = entry[taggableField];
    const newValue = `${currentValue} #topic/${topic}`;

    try {
      const success = await updateEntry(entry.id, newValue);
      if (success) {
        result.tagged++;
      } else {
        result.failed++;
      }
    } catch (error) {
      console.warn(`Warning: Failed to update entry ${entry.id}: ${error.message}`);
      result.failed++;
    }
  }

  return result;
}

/**
 * Create an update function for a plugin that uses file:lineNum IDs
 * This handles the common case of markdown-based plugins
 * @param {string} projectRoot - Project root path
 * @returns {object} - Updater with update() and flush() methods
 */
export function createFileBasedUpdater(projectRoot) {
  // Cache file contents to avoid repeated reads
  const fileCache = new Map();
  const modifiedFiles = new Set();

  return {
    /**
     * Update an entry in a file
     * @param {string} entryId - Entry ID in format sourceId:filepath:lineNum
     * @param {string} newValue - New value for the taggable field
     * @returns {boolean} - Whether update succeeded
     */
    update(entryId, newValue) {
      // Parse ID: sourceId:filepath:lineNum
      const idParts = entryId.split(':');
      if (idParts.length < 3) return false;

      // Extract filepath and line number
      const filePath = idParts.slice(1, -1).join(':');
      const lineNum = parseInt(idParts[idParts.length - 1], 10);

      const fullPath = path.join(projectRoot, filePath);
      if (!fs.existsSync(fullPath)) return false;

      // Get or cache file contents
      if (!fileCache.has(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        fileCache.set(fullPath, content.split('\n'));
      }

      const lines = fileCache.get(fullPath);
      if (lineNum >= lines.length) return false;

      const line = lines[lineNum];
      if (!line) return false;

      // For pipe-delimited format (time tracking), update the description field
      if (line.includes('|')) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          // Replace the description (last part) with new value
          parts[parts.length - 1] = newValue;
          lines[lineNum] = parts.join('|');
          modifiedFiles.add(fullPath);
          return true;
        }
      }

      return false;
    },

    /**
     * Flush modified files to disk
     */
    flush() {
      for (const filePath of modifiedFiles) {
        const lines = fileCache.get(filePath);
        if (lines) {
          fs.writeFileSync(filePath, lines.join('\n'));
        }
      }
      fileCache.clear();
      modifiedFiles.clear();
    }
  };
}
