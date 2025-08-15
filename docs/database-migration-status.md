# Database Migration Status

## Current State
- ✅ Turso database created and populated
- ✅ Database module (`src/database.js`) supports both Turso and local SQLite
- ⚠️ Most scripts still use `better-sqlite3` directly

## Files That Need Migration

### High Priority (Core functionality)
1. **src/task-manager.js**
   - Status: ❌ Uses `better-sqlite3` directly
   - Impact: Core task management
   - Action: Update to use `database.js` module

2. **src/sync-scheduler.js**
   - Status: ❌ Uses `better-sqlite3` directly
   - Impact: Sync operations
   - Action: Update to use `database.js` module

3. **src/sqlite-cache.js**
   - Status: ❌ Uses `better-sqlite3` directly
   - Impact: Caching layer
   - Action: Update to use `database.js` module

### Scripts That Import These
- `bin/tasks` - imports `task-manager.js`
- `bin/sync` - imports `sync-scheduler.js`
- `bin/notion` - uses caching
- Many others

## Turso Benefits for Multi-Deployment

### Automatic Collision Handling
- **ACID Transactions**: Atomicity, Consistency, Isolation, Durability
- **Row-level locking**: Multiple deployments can update different rows simultaneously
- **Optimistic concurrency**: Conflicts are detected and resolved automatically
- **Built-in retry logic**: Failed transactions are automatically retried

### Example Scenarios
1. **Two deployments updating different tasks**: Works perfectly, no collision
2. **Two deployments updating same task**: Last write wins, atomic updates
3. **One reading while other writes**: Read isolation ensures consistency

## Migration Path

### Phase 1: Update Core Modules (Current)
- [ ] Update `task-manager.js` to use `database.js`
- [ ] Update `sync-scheduler.js` to use `database.js`
- [ ] Update `sqlite-cache.js` to use `database.js`

### Phase 2: Test
- [ ] Test all bin scripts with Turso
- [ ] Verify multi-deployment scenarios
- [ ] Check performance

### Phase 3: Cleanup
- [ ] Remove `.data/` directory from deployments with Turso
- [ ] Update `.gitignore` if needed
- [ ] Document new deployment process

## After Migration

### With Turso Credentials (Production)
- No `.data/` directory needed
- All data in cloud
- Automatic sync between deployments
- Single source of truth

### Without Turso Credentials (Local Development)
- Falls back to `.data/today.db`
- Works offline
- Good for testing

## Current Issues
- 12 emails failed to migrate (0.9% of total)
- Will be resolved on next email sync from iCloud

## Next Steps
1. Update the three core modules to use `database.js`
2. Test thoroughly
3. Remove local database dependencies