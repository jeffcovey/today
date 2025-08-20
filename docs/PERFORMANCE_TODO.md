# Performance Optimization TODO

## Centralized API Calling - ✅ COMPLETED

- [x] Created `NotionAPIBase` class with centralized `queryDatabase()` method <!-- task-id: a4b06d87a45599a181628d0bcfa7ebb4 -->
- [x] Moved pagination logic to base class <!-- task-id: d852e3ee78ba90fa55052ea2d1080845 -->
- [x] Centralized error handling and caching patterns <!-- task-id: bfbacebaf61687d8a0fa29abb41a9099 -->
- [x] Updated `getTasksWithDoDate()` to use API filters instead of local filtering <!-- task-id: 3f5b379063d515cc78562ece595cd2a5 -->

## Next Performance Improvements

### 1. Implement Filtered Query Caching

Currently, filtered queries (like Do Date tasks) don't use caching because the SQLiteCache doesn't support storing filtered results separately.

**Solution**: Extend SQLiteCache to support:

```sql
CREATE TABLE filtered_cache (
  id TEXT PRIMARY KEY,
  database_id TEXT,
  filter_hash TEXT,
  results TEXT, -- JSON array of results
  last_edited_time TEXT,
  cached_at INTEGER
);
```

### 2. Incremental Sync Strategy

Implement the pattern mentioned by the user:
1. **Initial pull**: Full database fetch to populate cache
2. **Subsequent calls**:
   - First check cache
   - Only pull data newer than cache timestamp
   - Merge with existing cache

**Implementation**:

```javascript
async getTasksIncremental(databaseId, lastSyncTime) {
  return this.queryDatabaseIncremental({
    databaseId,
    lastSyncTime,
    filter: { /* status filters */ },
    // ... other options
  });
}
```

### 3. Cache Warming Strategy

Pre-fetch common queries in background:
- All actionable tasks
- Tasks with Do Date
- Unassigned tasks
- Tasks without tags

### 4. API Request Optimization Audit

Review all API calls to ensure we're only requesting needed data:
- [x] `getDatabases()` - Could cache longer (currently 5 minutes) <!-- task-id: 232074b4294eb45180106ee51dec0312 -->
- [x] `getAllProjects()` - Uses cache but could be optimized <!-- task-id: 9e5895469b07a1383f51daf36b1806cd -->
- [x] `getAllTags()` - Uses cache but could be optimized <!-- task-id: 31704203719975e5b87590923c1fb2da -->
- [x] Routine items (`getMorningRoutineItems()`, etc.) - Could use incremental sync <!-- task-id: d7daf94668c4744fab8671baa75f82e6 -->

### 5. Property Selection Optimization

Notion API supports selecting only specific properties. We could:
- Only fetch properties we actually use in the UI
- Reduce payload size significantly
- Faster network transfer and parsing

### 6. Concurrent Query Optimization

When showing the main menu, we fetch multiple data types sequentially. We could:
- Fetch routine items, projects, and tags in parallel
- Use Promise.allSettled for better error handling
- Show partial UI while other data loads

## Performance Metrics to Track

- Time to load main menu
- Cache hit rates
- API request count per session
- Time to load filtered views (Do Date, unassigned, etc.)
