/**
 * Runs one read-time freshness sync in its own process, so the MCP server's
 * event loop stays free while it runs (#690).
 *
 * Usage: node src/read-sync-worker.js <plugin-type>
 * Exits 0 when the sync ran or the data was already fresh, 1 on a failure.
 * Started by runReadSyncInChild in mcp-reads.js, from the server's working
 * directory, so it opens the same database.
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
  await ensureSyncForType(db, pluginType);
  process.exit(0);
} catch (error) {
  console.error(`read-sync-worker: ${pluginType} sync failed: ${error.message}`);
  process.exit(1);
}
