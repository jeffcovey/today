#!/usr/bin/env node

/**
 * Multi-tier caching for markdown file metadata
 *
 * Performance optimization for directory listings - combines:
 * 1. In-memory LRU cache (instant lookups)
 * 2. Database cache (persistent, validated by mtime)
 * 3. Optimized file reading (only first 2KB for title extraction)
 *
 * Typical performance:
 * - Memory cache hit: ~0.1ms
 * - Database cache hit: ~1-5ms
 * - File read (cache miss): ~10-50ms
 */

import fs from 'fs/promises';
import path from 'path';
import { getDatabase } from './database-service.js';

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
    this.db = null;
  }

  getDB() {
    if (!this.db) {
      this.db = getDatabase();
    }
    return this.db;
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
   * Get markdown file metadata with multi-tier caching
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

    // Tier 1: Check memory cache
    const memCached = this.memoryCache.get(filePath);
    if (memCached && memCached.mtimeMs === mtimeMs) {
      return memCached;
    }

    // Tier 2: Check database cache
    const db = this.getDB();
    const dbCached = db.prepare(`
      SELECT title, mtime_ms
      FROM markdown_files
      WHERE path = ?
    `).get(filePath);

    if (dbCached && dbCached.mtime_ms === mtimeMs) {
      // Valid cache - update memory cache
      const result = {
        path: filePath,
        title: dbCached.title,
        mtimeMs,
        sizeBytes
      };
      this.memoryCache.set(filePath, result);
      return result;
    }

    // Tier 3: Read file (cache miss or stale)
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

    // Update both caches
    this.updateCache(filePath, title, mtimeMs, sizeBytes);
    this.memoryCache.set(filePath, result);

    return result;
  }

  /**
   * Update database cache
   */
  updateCache(filePath, title, mtimeMs, sizeBytes) {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO markdown_files (path, title, mtime_ms, size_bytes, cached_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        cached_at = excluded.cached_at
    `).run(filePath, title, mtimeMs, sizeBytes, Date.now());
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
    const db = this.getDB();
    db.prepare('DELETE FROM markdown_files WHERE path = ?').run(filePath);
  }

  /**
   * Clear all caches
   */
  clearAll() {
    this.memoryCache.clear();
    const db = this.getDB();
    db.prepare('DELETE FROM markdown_files').run();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const db = this.getDB();
    const dbCount = db.prepare('SELECT COUNT(*) as count FROM markdown_files').get();

    return {
      memorySize: this.memoryCache.size,
      databaseSize: dbCount.count,
      memoryMaxSize: this.memoryCache.maxSize
    };
  }

  /**
   * Clean up old cache entries (older than 30 days)
   */
  cleanup(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const db = this.getDB();
    const cutoff = Date.now() - maxAgeMs;
    const result = db.prepare(`
      DELETE FROM markdown_files
      WHERE cached_at < ?
    `).run(cutoff);

    return result.changes;
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
