/**
 * Core AI chat service using ai-provider.js
 *
 * Provides chat functionality for files and directories using
 * the configured background AI provider.
 */

import { createCompletion, streamCompletion, getProviderName } from '../ai-provider.js';
import { buildFileContext, buildDirectoryContext, buildMessages } from './message-builder.js';
import { loadConversation, saveConversation, clearConversation } from './conversation-store.js';
import { createChatTools } from './tools.js';

// Re-export persistence functions for convenience
export { loadConversation, saveConversation, clearConversation };

// Re-export tools creation for convenience
export { createChatTools };

// Default max tokens for chat responses
const DEFAULT_MAX_TOKENS = 4000;

/**
 * Chat with a file
 * @param {Object} options
 * @param {string} options.urlPath - The URL path of the file
 * @param {string} options.message - The user's message
 * @param {Array} options.history - Previous conversation messages
 * @param {string} options.documentContent - Current content of the document
 * @param {boolean} [options.stream=false] - Whether to return a stream
 * @param {Object} [options.tools] - Tool definitions for the AI to use
 * @param {Function} [options.onStepFinish] - Callback when a step finishes (for streaming)
 * @returns {Promise<string|AsyncIterable>} - Response text or stream
 */
export async function chatWithFile({ urlPath, message, history, documentContent, stream = false, tools, onStepFinish }) {
  const systemContext = buildFileContext(urlPath, documentContent);
  const { system, messages } = buildMessages(systemContext, history, message);

  if (stream) {
    return streamCompletion({
      system,
      messages,
      maxTokens: DEFAULT_MAX_TOKENS,
      tools,
      onStepFinish,
    });
  }

  return createCompletion({
    system,
    messages,
    maxTokens: DEFAULT_MAX_TOKENS,
    tools,
  });
}

/**
 * Chat with a directory
 * @param {Object} options
 * @param {string} options.urlPath - The URL path of the directory
 * @param {string} options.message - The user's message
 * @param {Array} options.history - Previous conversation messages
 * @param {string} options.directoryContext - Description of directory contents
 * @returns {Promise<string>} - Response text
 */
export async function chatWithDirectory({ urlPath, message, history, directoryContext }) {
  const systemContext = buildDirectoryContext(urlPath, directoryContext);
  const { system, messages } = buildMessages(systemContext, history, message);

  return createCompletion({
    system,
    messages,
    maxTokens: DEFAULT_MAX_TOKENS,
  });
}

/**
 * Get the name of the AI provider being used
 * @returns {string} - Provider name
 */
export function getChatProviderName() {
  return getProviderName();
}
