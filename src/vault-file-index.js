/**
 * In-memory index of every markdown file in the vault with its frontmatter,
 * used by the Dataview emulation (dv.pages(), DQL FROM, etc.).
 *
 * Building the index from scratch means reading and YAML-parsing ~10k files,
 * which takes several seconds. So the index is never rebuilt in a request's
 * path once it exists: a stale index is returned immediately while a refresh
 * runs in the background, and refreshes only re-read files whose mtime or size
 * changed.
 */

import fs from 'fs/promises';
import path from 'path';
import { parseFrontmatter } from './frontmatter.js';

export const DEFAULT_MAX_AGE_MS = 60 * 1000;
const DEFAULT_CONCURRENCY = 32;

// Vault-relative paths of all markdown files, in depth-first readdir order.
async function listMarkdownFiles(vaultPath) {
  const files = [];

  async function walkDir(dir, relativePath) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden files and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walkDir(path.join(dir, entry.name), relPath);
      } else if (entry.name.endsWith('.md')) {
        files.push(relPath);
      }
    }
  }

  await walkDir(vaultPath, '');
  return files;
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function buildFileRecord(relPath, properties) {
  const name = path.basename(relPath).replace('.md', '');
  const folder = path.dirname(relPath);
  return {
    ...(properties || {}),
    path: relPath,
    name,
    folder,
    frontmatter: properties || {},
    file: { path: relPath, name, folder }
  };
}

export class VaultFileIndex {
  constructor(vaultPath, { maxAgeMs = DEFAULT_MAX_AGE_MS, concurrency = DEFAULT_CONCURRENCY, now = Date.now, onError } = {}) {
    this.vaultPath = vaultPath;
    this.maxAgeMs = maxAgeMs;
    this.concurrency = concurrency;
    this.now = now;
    this.onError = onError || (() => {});
    this.files = null;
    this.builtAt = 0;
    this.refreshing = null;
    this.entries = new Map(); // relPath -> { mtimeMs, size, record }
  }

  /**
   * The current file list. Only waits when no index has been built yet;
   * otherwise a stale index is returned and refreshed in the background.
   */
  async get() {
    if (!this.files) return this.refresh();
    if (this.now() - this.builtAt >= this.maxAgeMs) {
      this.refresh().catch(this.onError);
    }
    return this.files;
  }

  /** Rescan the vault. Concurrent callers share one in-flight scan. */
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.rebuild().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async rebuild() {
    const startedAt = this.now();
    const relPaths = await listMarkdownFiles(this.vaultPath);
    const entries = new Map();

    const records = await mapWithConcurrency(relPaths, this.concurrency, async (relPath) => {
      try {
        const fullPath = path.join(this.vaultPath, relPath);
        const stats = await fs.stat(fullPath);
        const previous = this.entries.get(relPath);
        if (previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
          entries.set(relPath, previous);
          return previous.record;
        }
        const content = await fs.readFile(fullPath, 'utf-8');
        const { properties } = parseFrontmatter(content);
        const record = buildFileRecord(relPath, properties);
        entries.set(relPath, { mtimeMs: stats.mtimeMs, size: stats.size, record });
        return record;
      } catch {
        // Silently skip files we can't read (eg. deleted mid-scan); parse
        // errors are already logged by parseFrontmatter
        return null;
      }
    });

    this.entries = entries;
    this.files = records.filter(Boolean);
    this.builtAt = startedAt;
    return this.files;
  }
}
