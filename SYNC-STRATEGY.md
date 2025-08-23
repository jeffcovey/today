# Database Sync Strategy

## Problem

- Local database is 89MB with emails, cached data, etc.
- Turso embedded replicas timeout on initial sync of large databases
- Need bidirectional sync with conflict resolution

## Current Best Solution: Keep Custom Batch Sync

After testing, we found that Turso embedded replicas have limitations:

1. **No partial/incremental initial sync** - Tries to download entire database at once
2. **No progress reporting** - Can't see what's happening during long syncs  
3. **Timeouts on large databases** - Our 89MB database consistently times out
4. **No batch upload support** - Can't upload large local database in chunks

## Recommended Approach

### For Your Current Situation (Large Existing Database)

**Keep using your custom sync (`bin/turso-sync`)** because:
- Handles batching (1000 rows at a time)
- Shows progress during sync
- Only syncs recent changes by default
- Has proper conflict resolution with timestamps
- Works reliably with your 89MB database

### For Future Projects (Starting Fresh)

**Option 1: Start Small with Embedded Replicas**
- Begin with embedded replicas from day one
- Keep database small (<10MB)
- Archive old data periodically

**Option 2: Hybrid Approach**

```javascript
// For initial setup or recovery
bin/turso-sync pull  // Batch sync

// For daily operations (small incremental changes)
const client = createClient({
  url: 'file:local.db',
  syncUrl: tursoUrl,
  syncInterval: 60
});
```

**Option 3: Alternative Solutions**
- **Litestream**: For one-way backup to S3
- **cr-sqlite**: For CRDT-based conflict resolution
- **PowerSync**: For Postgres ↔ SQLite sync

## Implementation Status

✅ Custom batch sync working well
✅ Conflict resolution implemented  
✅ Schema versioning in place
❌ Embedded replicas not viable for large databases

## Next Steps

1. Optimize current sync:
   - Add compression for email content
   - Archive old emails (>90 days) to separate database
   - Consider storing email attachments separately

2. Monitor database growth:
   - Current: 89MB
   - Target: <50MB for potential embedded replica migration
   - Archive strategy needed at 100MB+

## Code Locations

- Batch sync: `/bin/turso-sync` (KEEP THIS)
- Conflict resolution: Lines 469-504 in `bin/turso-sync`
- Schema migrations: `/src/migrations.js`
- Database wrapper: `/src/database-wrapper.js` (for local-only mode)
