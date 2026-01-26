/**
 * Vault-based conversation persistence for AI chat
 *
 * Stores conversations as JSON files in vault/.ai-chat/conversations/
 * Uses SHA256 hash of path (16 chars) for filenames to avoid path character issues
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getAbsoluteVaultPath } from '../config.js';

/**
 * Get the conversations directory path (lazy, uses configured vault)
 */
function getConversationsDir() {
  return path.join(getAbsoluteVaultPath(), '.ai-chat', 'conversations');
}

/**
 * Generate a hash-based filename from a path
 * @param {string} urlPath - The URL path (e.g., "notes/my-file.md")
 * @returns {string} - 16-character hash + .json extension
 */
function getConversationFilename(urlPath) {
  const normalized = urlPath || 'root';
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${hash}.json`;
}

/**
 * Ensure the conversations directory exists
 */
async function ensureConversationsDir() {
  await fs.mkdir(getConversationsDir(), { recursive: true });
}

/**
 * Get the full path to a conversation file
 * @param {string} urlPath - The URL path
 * @returns {string} - Full filesystem path to conversation JSON
 */
function getConversationPath(urlPath) {
  return path.join(getConversationsDir(), getConversationFilename(urlPath));
}

/**
 * Load a conversation from the vault
 * @param {string} urlPath - The URL path of the file/directory
 * @returns {Promise<Array>} - Array of message objects, or empty array if none exists
 */
export async function loadConversation(urlPath) {
  try {
    const filePath = getConversationPath(urlPath);
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return data.messages || [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, return empty conversation
      return [];
    }
    console.error(`[conversation-store] Error loading conversation for ${urlPath}:`, error.message);
    return [];
  }
}

/**
 * Save a conversation to the vault
 * @param {string} urlPath - The URL path of the file/directory
 * @param {Array} messages - Array of message objects { role, content, timestamp }
 * @returns {Promise<void>}
 */
export async function saveConversation(urlPath, messages) {
  try {
    await ensureConversationsDir();
    const filePath = getConversationPath(urlPath);
    const data = {
      path: urlPath || 'root',
      updatedAt: new Date().toISOString(),
      messages: messages,
    };
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error(`[conversation-store] Error saving conversation for ${urlPath}:`, error.message);
    throw error;
  }
}

/**
 * Clear/delete a conversation from the vault
 * @param {string} urlPath - The URL path of the file/directory
 * @returns {Promise<boolean>} - true if deleted, false if didn't exist
 */
export async function clearConversation(urlPath) {
  try {
    const filePath = getConversationPath(urlPath);
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    console.error(`[conversation-store] Error clearing conversation for ${urlPath}:`, error.message);
    throw error;
  }
}
