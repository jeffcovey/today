/**
 * Runs one read-time freshness sync in its own process, so the MCP server's
 * event loop stays free while it runs (#690).
 *
 * Usage: node src/read-sync-worker.js <plugin-type>
 * Exits 0 once ensureSyncForType returns, and 1 only when the worker itself
 * can't run (no type given, or an error that escapes ensureSyncForType).
 * As with the in-process read syncs this replaces, a source whose sync fails
 * doesn't fail the read: ensureSyncForType skips past it, so that is still
 * exit 0. syncForRead uses the exit only to know the sync is over.
 * Started by runReadSyncInChild in mcp-reads.js, from the server's working
 * directory, so it opens the same database.
 * The sync is read-only (skipWriteHooks): it refreshes the database from the
 * files as they stand and writes nothing to the vault.
 */

import { getDatabase } from './database-service.js';
import { ensureSyncForType } from './plugin-loader.js';
import { stopProcessGroupsBeforeExitOnSigterm } from './process-group.js';

const pluginType = process.argv[2];

if (!pluginType) {
  console.error('read-sync-worker: no plugin type given');
  process.exit(1);
}

try {
  const db = getDatabase();
  // runReadSyncInChild sends SIGTERM when the worker overruns. Stop the
  // plugin commands' detached process groups before exiting, or they would
  // keep running with no timeout left to end them.
  stopProcessGroupsBeforeExitOnSigterm({ killGraceMs: 2000 });
  // Read-only: a read must not change the vault. No write hooks, and the
  // readers run with READ_ONLY=true (no auto-tagging either, which
  // ensureSyncForType skips by default). sync_data is the full sync.
  await ensureSyncForType(db, pluginType, { skipWriteHooks: true });
  process.exit(0);
} catch (error) {
  console.error(`read-sync-worker: ${pluginType} sync failed: ${error.message}`);
  process.exit(1);
}
