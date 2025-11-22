#!/usr/bin/env node

/**
 * Memory-only cache for markdown file metadata
 *
 * Performance optimization for directory listings using LRU cache.
 *
 * NOTE: Database persistence disabled due to locking issues on production.
 * The markdown_files table exists (created by migration v32) but is not used.
 * Future: Re-enable database caching once locking issues are resolved.
 *
 * Performance:
 * - Memory cache hit: ~0.1ms
 * - Cache miss (file read): ~10-50ms (only reads first 2KB)
 */

import fs from 'fs/promises';

// In-memory LRU cache
class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;

    // Move to end (most recently used)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    // Remove if exists (to reinsert at end)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Add to end
    this.cache.set(key, value);

    // Evict oldest if over size
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

class MarkdownFileCache {
  constructor() {
    this.memoryCache = new LRUCache(500);
  }

  /**
   * Read only the first chunk of a file to extract the title
   * Much faster than reading entire file
   */
  async readFileChunk(filePath, maxBytes = 2048) {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /**
   * Extract markdown title from content
   */
  extractTitle(content) {
    // Look for first H1 heading
    const titleMatch = content.match(/^# (.+)$/m);
    if (titleMatch) {
      return titleMatch[1].trim();
    }
    return null;
  }

  /**
   * Get file metadata (size, mtime)
   */
  async getFileStats(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return {
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Get markdown file metadata with memory-only caching
   *
   * @param {string} filePath - Absolute path to markdown file
   * @returns {Promise<{title: string|null, path: string}>}
   */
  async getFileMetadata(filePath) {
    const stats = await this.getFileStats(filePath);
    if (!stats) {
      return { path: filePath, title: null };
    }

    const { mtimeMs, sizeBytes } = stats;

    // Check memory cache
    const cached = this.memoryCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached;
    }

    // Read file (cache miss or stale)
    let title = null;
    try {
      const content = await this.readFileChunk(filePath);
      title = this.extractTitle(content);
    } catch (error) {
      console.error(`Error reading ${filePath}:`, error.message);
    }

    const result = {
      path: filePath,
      title,
      mtimeMs,
      sizeBytes
    };

    // Update memory cache
    this.memoryCache.set(filePath, result);

    return result;
  }

  /**
   * Batch get metadata for multiple files (optimized)
   */
  async getBatchMetadata(filePaths) {
    const results = await Promise.all(
      filePaths.map(filePath => this.getFileMetadata(filePath))
    );
    return results;
  }

  /**
   * Invalidate cache for a specific file
   */
  invalidate(filePath) {
    this.memoryCache.delete(filePath);
  }

  /**
   * Clear all caches
   */
  clearAll() {
    this.memoryCache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      memorySize: this.memoryCache.size,
      memoryMaxSize: this.memoryCache.maxSize
    };
  }
}

// Singleton instance
let instance = null;

export function getMarkdownFileCache() {
  if (!instance) {
    instance = new MarkdownFileCache();
  }
  return instance;
}

// Export class for testing
export { MarkdownFileCache };
