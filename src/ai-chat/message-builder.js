/**
 * Message and prompt construction helpers for AI chat
 */

import { schemas } from '../plugin-schemas.js';

/**
 * Get a summary of available data types from plugin schemas
 */
function getAvailableDataTypes() {
  const types = [];
  for (const [type, schema] of Object.entries(schemas)) {
    if (schema.ai && schema.table) {
      types.push(`- ${schema.ai.name} (${schema.table}): ${schema.ai.description.split('\n')[0]}`);
    }
  }
  return types.join('\n');
}

/**
 * Build system context for file chat
 * @param {string} urlPath - The URL path of the file
 * @param {string} documentContent - The current content of the document
 * @returns {string} - System prompt
 */
export function buildFileContext(urlPath, documentContent) {
  let context = 'You are an AI assistant helping with a markdown document in a personal knowledge vault. ';
  context += `The user is viewing: ${urlPath}\n`;
  context += `File location: vault/${urlPath}\n\n`;

  context += '## Available Tools\n\n';
  context += 'You have access to the following tools:\n\n';

  context += '### edit_file\n';
  context += 'Use this to edit the current document using search-and-replace. Provide:\n';
  context += '- oldText: The exact text to find (must match exactly, include enough context to be unique)\n';
  context += '- newText: The replacement text\n';
  context += 'The interface will automatically refresh after edits.\n\n';

  context += '### query_database\n';
  context += 'Query the SQLite database containing user data from plugins. Available data:\n';
  context += getAvailableDataTypes();
  context += '\n\n';

  context += '### run_command\n';
  context += 'Run commands from the Today CLI toolkit (bin/ directory). Available commands include:\n';
  context += '- calendar: View and manage calendar events\n';
  context += '- tasks: List, add, and complete tasks\n';
  context += '- track: Time tracking (start, stop, status)\n';
  context += '- diary: Journal entries and reflections\n';
  context += '- projects: Project management and review\n';
  context += '- habits: Habit tracking and streaks\n';
  context += '- contacts: Contact information and birthdays\n';
  context += '- health: Health metrics and summaries\n';
  context += '- finance: Financial data and budgets\n\n';

  context += '## Guidelines\n\n';
  context += '- When editing, preserve the document structure (frontmatter, headings, etc.)\n';
  context += '- Use tools proactively when they would help answer the user\'s question\n';
  context += '- For questions about schedules, tasks, or data, query the database or run commands\n\n';

  context += '---CURRENT DOCUMENT CONTENT---\n';
  context += documentContent || '(No document content available)';
  context += '\n---END DOCUMENT---';
  return context;
}

/**
 * Build system context for directory chat
 * @param {string} urlPath - The URL path of the directory
 * @param {string} directoryContext - Description of directory contents
 * @returns {string} - System prompt
 */
export function buildDirectoryContext(urlPath, directoryContext) {
  let context = 'You are an AI assistant helping with a directory in a markdown vault. ';
  context += `The user is viewing directory: ${urlPath || '/'}\n`;
  context += `Full path: vault/${urlPath || '/'}\n\n`;
  context += 'Directory contents:\n';
  context += directoryContext || '(No directory content available)';
  context += '\n\n';
  context += 'You can help the user understand what files are in this directory, ';
  context += 'suggest which files to look at, and answer questions about organizing ';
  context += 'or navigating the content.';
  return context;
}

/**
 * Build the messages array for the AI provider
 * @param {string} systemContext - The system prompt with file/directory context
 * @param {Array} history - Previous conversation messages
 * @param {string} userMessage - The current user message
 * @returns {{ system: string, messages: Array }} - Object with system prompt and messages array
 */
export function buildMessages(systemContext, history, userMessage) {
  const messages = [];

  // Add history messages, filtering out empty content (Anthropic API rejects these)
  if (history && history.length > 0) {
    for (const msg of history) {
      // Skip messages with empty or whitespace-only content
      if (!msg.content || !msg.content.trim()) {
        continue;
      }
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  // Add the current user message
  messages.push({
    role: 'user',
    content: userMessage,
  });

  return {
    system: systemContext,
    messages,
  };
}
