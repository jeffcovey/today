// Reconcile cached email rows against the UIDs a folder actually holds.
//
// Incremental sync only ever looks forward from uidNext, so a message that is
// expunged or moved out of a folder (archived by hand, filed by a server-side
// rule such as SaneBox) leaves its row behind forever. Without reconciliation
// the cache only grows, and folder-scoped queries report messages that are no
// longer there.
//
// Reconciliation claims authority only over the window the sync actually
// covers. Rows older than that are kept: we never asked the server about them,
// so their absence from a windowed search proves nothing. To keep the two
// windows from disagreeing at the edge -- IMAP SINCE matches on the server's
// internal date, while the cached date comes from the message envelope -- the
// server is asked for a wider span than the rows we are willing to delete.

import Database from 'better-sqlite3';

// Days of slack between the server search window and the deletion window.
export const WINDOW_SLACK_DAYS = 7;

export function searchSince(sinceDate, slackDays = WINDOW_SLACK_DAYS) {
  const padded = new Date(sinceDate);
  padded.setDate(padded.getDate() - slackDays);
  return padded;
}

// A UID is a positive integer. Anything else -- null, '', a non-numeric string
// -- is not a UID. Number() alone will not do: Number(null) and Number('') are
// both 0, which would make an unidentifiable row look like UID 0 and be deleted.
function toUid(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Rows whose UID is absent from the server's list are stale. Rows without a
// usable UID are left alone: we cannot prove they are gone.
export function findStaleIds(rows, serverUids) {
  const live = new Set();
  for (const uid of serverUids) {
    const n = toUid(uid);
    if (n !== null) live.add(n);
  }

  const stale = [];
  for (const row of rows) {
    const uid = toUid(row.uid);
    if (uid === null) continue;
    if (!live.has(uid)) stale.push(row.id);
  }
  return stale;
}

// An empty search result is ambiguous: it means either that nothing in the
// folder falls inside the window, or that the search did not really run. When
// the mailbox holds messages and we have rows cached for it, decline to read
// that emptiness as "delete everything". Any later message makes the result
// non-empty and reconciliation resumes.
export function isTrustworthyUidList(serverUids, { messageCount, cachedRowCount }) {
  if (!Array.isArray(serverUids)) return false;
  if (serverUids.length === 0 && messageCount > 0 && cachedRowCount > 0) return false;
  return true;
}

export function reconcileFolder(dbPath, sourceId, folderPath, serverUids, options = {}) {
  const { messageCount = 0, deleteRowsSince = null } = options;

  const db = new Database(dbPath, { timeout: 5000 });
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');

    const params = [sourceId, folderPath];
    let sql = `
      SELECT id, json_extract(metadata, '$.uid') AS uid
      FROM email WHERE source = ? AND folder = ?
    `;
    if (deleteRowsSince) {
      sql += ' AND date >= ?';
      params.push(deleteRowsSince);
    }
    const rows = db.prepare(sql).all(...params);

    if (!isTrustworthyUidList(serverUids, { messageCount, cachedRowCount: rows.length })) {
      return 0;
    }

    const stale = findStaleIds(rows, serverUids);
    if (stale.length === 0) return 0;

    const stmt = db.prepare('DELETE FROM email WHERE id = ?');
    const removeAll = db.transaction(ids => {
      let removed = 0;
      for (const id of ids) removed += stmt.run(id).changes;
      return removed;
    });
    return removeAll(stale);
  } finally {
    db.close();
  }
}
