import { jest } from '@jest/globals';
import { SQLiteCache } from '../src/sqlite-cache.js';
import fs from 'fs';
import path from 'path';

describe('SQLiteCache', () => {
  let cache;
  const testDbPath = './test-cache.db';

  beforeEach(() => {
    // Clean up any existing test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    cache = new SQLiteCache(testDbPath);
  });

  afterEach(() => {
    if (cache) {
      cache.close();
    }
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('Basic Operations', () => {
    test('should set and get a value', async () => {
      const key = 'test-key';
      const value = { data: 'test data' };
      
      await cache.set(key, value);
      const retrieved = await cache.get(key);
      
      expect(retrieved).toEqual(value);
    });

    test('should return null for non-existent key', async () => {
      const result = await cache.get('non-existent');
      expect(result).toBeNull();
    });

    test('should handle TTL expiration', async () => {
      const key = 'ttl-test';
      const value = { data: 'expires soon' };
      
      // Set with 1 second TTL
      await cache.set(key, value, 1);
      
      // Should exist immediately
      let retrieved = await cache.get(key);
      expect(retrieved).toEqual(value);
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Should be expired
      retrieved = await cache.get(key);
      expect(retrieved).toBeNull();
    });
  });

  describe('Delete Operations', () => {
    test('should delete a key', async () => {
      const key = 'delete-test';
      const value = { data: 'to be deleted' };
      
      await cache.set(key, value);
      expect(await cache.get(key)).toEqual(value);
      
      await cache.delete(key);
      expect(await cache.get(key)).toBeNull();
    });

    test('should handle deleting non-existent key', async () => {
      // Should not throw
      await expect(cache.delete('non-existent')).resolves.not.toThrow();
    });
  });

  describe('Clear Operations', () => {
    test('should clear all entries', async () => {
      await cache.set('key1', { data: 1 });
      await cache.set('key2', { data: 2 });
      await cache.set('key3', { data: 3 });
      
      await cache.clear();
      
      expect(await cache.get('key1')).toBeNull();
      expect(await cache.get('key2')).toBeNull();
      expect(await cache.get('key3')).toBeNull();
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid JSON gracefully', async () => {
      // Directly insert invalid JSON
      const db = cache.db;
      db.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)').run(
        'bad-json',
        'not valid json',
        Date.now() + 10000
      );
      
      const result = await cache.get('bad-json');
      expect(result).toBeNull();
    });
  });
});