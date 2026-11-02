import Database from 'better-sqlite3';

// Retry unfinished work using identifiers only, never cached body content.
export function getPendingBodies(dbPath, sourceId, newEmails = []) {
  const pending = new Map();
  let db;
  try {
    db = new Database(dbPath, { readonly: true, timeout: 5000 });
    const rows = db.prepare(`
      SELECT folder, json_extract(metadata, '$.uid') AS uid, size
      FROM email
      WHERE source = ? AND json_extract(metadata, '$.needs_body') = true
    `).all(sourceId);
    for (const row of rows) {
      pending.set(JSON.stringify([row.folder, row.uid]), row);
    }
  } catch (error) {
    // The database or email table may not exist on the first sync.
    console.error(`  Warning: could not read pending bodies: ${error.message}`);
  } finally {
    db?.close();
  }
  for (const email of newEmails) {
    pending.set(JSON.stringify([email.folder, email.uid]), email);
  }
  return [...pending.values()];
}
