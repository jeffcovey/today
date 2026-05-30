import { jest } from '@jest/globals';

// Mock config so timezone/config path are deterministic and don't read disk.
jest.unstable_mockModule('../src/config.js', () => ({
  getTimezone: jest.fn().mockReturnValue('America/New_York'),
  getConfigPath: jest.fn().mockReturnValue('config.toml'),
  getFullConfig: jest.fn().mockReturnValue({}),
}));

// Mock plugin-loader so context gathering sees no enabled plugins (no execSync).
const getAIInstructionsByType = jest.fn();
const getPluginSources = jest.fn().mockReturnValue([]);
jest.unstable_mockModule('../src/plugin-loader.js', () => ({
  getAIInstructionsByType,
  getPluginSources,
}));

const Database = (await import('better-sqlite3')).default;
const { MigrationManager } = await import('../src/migrations.js');
const {
  CONTEXT_CACHE_VERSION,
  computeContextCacheKey,
  getCachedContext,
  setCachedContext,
  getDataContextCached,
} = await import('../src/context-cache.js');

function makeInstructions(entries = []) {
  // entries: [type, { sources, instructions }]
  return new Map(entries);
}

describe('context cache', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    await new MigrationManager(db, { verbose: false }).runMigrations();
    getAIInstructionsByType.mockReset();
    getAIInstructionsByType.mockResolvedValue(makeInstructions());
    delete process.env.SKIP_CONTEXT;
    delete process.env.SKIP_CONTEXT_CACHE;
  });

  afterEach(() => {
    db.close();
  });

  describe('migration 105', () => {
    test('creates the context_cache table', () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='context_cache'"
      ).get();
      expect(row).toBeDefined();
      expect(row.name).toBe('context_cache');
    });
  });

  describe('computeContextCacheKey', () => {
    const base = () => ({
      db,
      instructionsByType: makeInstructions([['tasks', { sources: ['gh/today'], instructions: [] }]]),
      dayKey: '2026-05-30',
      targetDate: null,
    });

    test('is deterministic for identical inputs', () => {
      expect(computeContextCacheKey(base())).toBe(computeContextCacheKey(base()));
    });

    test('is order-independent for sources and instructions', () => {
      const a = computeContextCacheKey({
        ...base(),
        instructionsByType: makeInstructions([['tasks', { sources: ['a', 'b'], instructions: [] }]]),
      });
      const b = computeContextCacheKey({
        ...base(),
        instructionsByType: makeInstructions([['tasks', { sources: ['b', 'a'], instructions: [] }]]),
      });
      expect(a).toBe(b);
    });

    test('changes when the day changes', () => {
      const a = computeContextCacheKey(base());
      const b = computeContextCacheKey({ ...base(), dayKey: '2026-05-31' });
      expect(a).not.toBe(b);
    });

    test('changes for a historical targetDate', () => {
      const a = computeContextCacheKey(base());
      const b = computeContextCacheKey({ ...base(), targetDate: '2026-01-01' });
      expect(a).not.toBe(b);
    });

    test('changes when instructions change', () => {
      const a = computeContextCacheKey(base());
      const b = computeContextCacheKey({
        ...base(),
        instructionsByType: makeInstructions([
          ['tasks', { sources: ['gh/today'], instructions: [{ sourceId: 'gh/today', text: 'be brief' }] }],
        ]),
      });
      expect(a).not.toBe(b);
    });

    test('changes when sync_metadata changes (the core invalidation signal)', () => {
      const before = computeContextCacheKey(base());
      db.prepare(
        'INSERT INTO sync_metadata (source, last_synced_at, entries_count) VALUES (?, ?, ?)'
      ).run('gh/today', '2026-05-30 12:00:00', 3);
      const after = computeContextCacheKey(base());
      expect(before).not.toBe(after);

      // A later sync time changes it again.
      db.prepare('UPDATE sync_metadata SET last_synced_at = ? WHERE source = ?')
        .run('2026-05-30 13:00:00', 'gh/today');
      expect(computeContextCacheKey(base())).not.toBe(after);
    });

    test('folds in the cache version', () => {
      expect(CONTEXT_CACHE_VERSION).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getCachedContext / setCachedContext', () => {
    test('round-trips content', () => {
      expect(getCachedContext(db, 'k1')).toBeNull();
      setCachedContext(db, 'k1', 'hello');
      expect(getCachedContext(db, 'k1')).toBe('hello');
    });

    test('upserts content for an existing key', () => {
      setCachedContext(db, 'k1', 'first');
      setCachedContext(db, 'k1', 'second');
      expect(getCachedContext(db, 'k1')).toBe('second');
      expect(db.prepare('SELECT COUNT(*) AS n FROM context_cache').get().n).toBe(1);
    });

    test('prunes to a bounded number of rows', () => {
      for (let i = 0; i < 9; i++) {
        setCachedContext(db, `key-${i}`, `content-${i}`);
      }
      const n = db.prepare('SELECT COUNT(*) AS n FROM context_cache').get().n;
      expect(n).toBeLessThanOrEqual(5);
    });
  });

  describe('getDataContextCached', () => {
    const call = (opts = {}) =>
      getDataContextCached({ db, projectRoot: '/tmp', targetDate: null, ...opts });

    test('gathers on a miss, then serves from cache on the next call', async () => {
      const first = await call();
      expect(first.cached).toBe(false);
      expect(first.content).toContain('No plugins are currently enabled');
      expect(db.prepare('SELECT COUNT(*) AS n FROM context_cache').get().n).toBe(1);

      // Prove the second call serves the stored row rather than re-gathering:
      // overwrite the cached content and confirm it comes back verbatim.
      db.prepare('UPDATE context_cache SET content = ?').run('SENTINEL');
      const second = await call();
      expect(second.cached).toBe(true);
      expect(second.content).toBe('SENTINEL');
    });

    test('bypass forces a fresh gather even when a cache row exists', async () => {
      await call();
      db.prepare('UPDATE context_cache SET content = ?').run('SENTINEL');

      const fresh = await call({ bypass: true });
      expect(fresh.cached).toBe(false);
      expect(fresh.content).toContain('No plugins are currently enabled');
      // The fresh gather refreshes the stored row.
      expect(getCachedContext(db, db.prepare('SELECT cache_key FROM context_cache').get().cache_key))
        .toContain('No plugins are currently enabled');
    });

    test('invalidates after a simulated sync', async () => {
      await call();
      db.prepare('UPDATE context_cache SET content = ?').run('SENTINEL');

      // Simulate a sync: sync_metadata changes -> key changes -> miss.
      db.prepare(
        'INSERT INTO sync_metadata (source, last_synced_at, entries_count) VALUES (?, ?, ?)'
      ).run('gh/today', '2026-05-30 12:00:00', 1);

      const afterSync = await call();
      expect(afterSync.cached).toBe(false);
      expect(afterSync.content).not.toBe('SENTINEL');
    });

    test('honors the SKIP_CONTEXT test short-circuit without caching', async () => {
      process.env.SKIP_CONTEXT = 'true';
      const res = await call();
      expect(res.cached).toBe(false);
      expect(res.content).toContain('Context gathering skipped for testing');
      expect(db.prepare('SELECT COUNT(*) AS n FROM context_cache').get().n).toBe(0);
    });
  });
});
