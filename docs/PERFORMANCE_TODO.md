# Performance Optimization TODO

## Centralized API Calling - ✅ COMPLETED

- [x] Created `NotionAPIBase` class with centralized `queryDatabase()` method
- [x] Moved pagination logic to base class
- [x] Centralized error handling and caching patterns
- [x] Updated `getTasksWithDoDate()` to use API filters instead of local filtering

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
- [ ] `getDatabases()` - Could cache longer (currently 5 minutes)
- [ ] `getAllProjects()` - Uses cache but could be optimized
- [ ] `getAllTags()` - Uses cache but could be optimized
- [ ] Routine items (`getMorningRoutineItems()`, etc.) - Could use incremental sync

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
