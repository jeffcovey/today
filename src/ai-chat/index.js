/**
 * AI Chat Module - Public API
 *
 * Provides AI chat functionality for files and directories
 * with vault-based conversation persistence.
 */

// Chat functions
export {
  chatWithFile,
  chatWithDirectory,
  getChatProviderName,
} from './chat-service.js';

// Conversation persistence
export {
  loadConversation,
  saveConversation,
  clearConversation,
} from './conversation-store.js';

// Message building utilities
export {
  buildFileContext,
  buildDirectoryContext,
  buildMessages,
} from './message-builder.js';

// Tool creation
export { createChatTools } from './tools.js';
