/**
 * Atomic file writes for vault markdown.
 *
 * Plan/project/task files in the vault are written by multiple concurrent
 * "Today" instances that share the vault filesystem but each have their own
 * .data/today.db (so the SQLite sync lock does NOT coordinate them). A bare
 * fs.writeFileSync truncates-then-writes, so a reader in another instance can
 * observe an empty or partial file, and a file-sync service can turn that
 * window into a conflict that leaves the file deleted. Writing to a temp file
 * in the same directory and renaming over the target makes the swap atomic:
 * a reader sees either the complete old file or the complete new file.
 *
 * writeFileAtomic also skips the write entirely when the new content is
 * byte-identical to what is already on disk. That is the single biggest
 * anti-thrash measure: when several instances independently compute the same
 * rendered file (the common case), only the first one writes and the rest
 * no-op, which is also the safest possible behaviour for a file-sync service
 * (no write means no conflict).
 *
 * writeFileAtomicCAS adds compare-and-swap for the genuine-change race: a
 * read-modify-write caller passes the bytes it originally read, and the swap
 * is aborted if the on-disk bytes no longer match (another instance wrote in
 * between). A lockfile is deliberately NOT used: instances have separate DBs
 * and the vault may be backed by a file-sync service, so a lockfile placed in
 * the vault would itself sync between machines and become a stale, conflicting
 * artifact. CAS needs no shared state, tolerates the sync service, and shrinks
 * the race window from the whole read-modify-write down to compare->rename. A
 * lost update is simply retried on the next sync and converges.
 */

import fs from 'fs';
import path from 'path';

/**
 * Temp-file + fsync + rename over `filePath`. Atomic within a filesystem.
 * @returns {true}
 */
function atomicReplace(filePath, content, encoding) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Temp file in the SAME directory so rename stays on one filesystem (rename
  // is only atomic within a filesystem). Unique per process + attempt so two
  // instances writing the same target never collide on the temp path.
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, content, { encoding });
      // Flush to disk before the rename so a crash can't leave the renamed
      // target pointing at unflushed (empty) data.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    // Never leave the temp file behind on failure.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Temp file already gone or never created.
    }
    throw err;
  }
}

/**
 * Write `content` to `filePath` atomically via a same-directory temp file
 * plus rename. Skips the write if the target already holds identical bytes.
 *
 * Signature-compatible with fs.writeFileSync(path, content, 'utf-8') so it can
 * be used as a drop-in replacement; the encoding argument is accepted and
 * applied to both the existing-content comparison and the temp write.
 *
 * @param {string} filePath - Absolute or relative path to the target file.
 * @param {string|Buffer} content - Content to write.
 * @param {string} [encoding='utf-8'] - Encoding for string content.
 * @returns {boolean} true if bytes were written, false if skipped as unchanged.
 */
export function writeFileAtomic(filePath, content, encoding = 'utf-8') {
  // Skip-if-unchanged: compare against current on-disk bytes. Any read error
  // (missing file, unreadable) just falls through to writing.
  try {
    const existing = fs.readFileSync(filePath, encoding);
    if (existing === content) {
      return false;
    }
  } catch {
    // Target missing or unreadable — proceed to write.
  }

  return atomicReplace(filePath, content, encoding);
}

/**
 * Compare-and-swap atomic write for read-modify-write callers.
 *
 * `expectedContent` is the exact bytes the caller read before computing
 * `content`. Immediately before the rename we re-read the file: if it no
 * longer matches `expectedContent`, another instance changed it in between, so
 * we abort WITHOUT writing (the caller's update is stale; the next sync
 * recomputes from fresh state and converges). Identical content is skipped as
 * unchanged, exactly like writeFileAtomic.
 *
 * @param {string} filePath - Target file.
 * @param {string} content - New content the caller computed.
 * @param {string} expectedContent - Bytes the caller originally read.
 * @param {string} [encoding='utf-8'] - Encoding.
 * @returns {{written: boolean, conflict: boolean}} written=true if the swap
 *   happened; conflict=true if it was aborted due to a concurrent change.
 */
export function writeFileAtomicCAS(filePath, content, expectedContent, encoding = 'utf-8') {
  let current;
  try {
    current = fs.readFileSync(filePath, encoding);
  } catch {
    current = null;
  }

  // Concurrent change since the caller read: abort, let the next sync retry.
  if (current !== expectedContent) {
    return { written: false, conflict: true };
  }

  // Nothing actually changed — skip the write (no file-sync churn).
  if (current === content) {
    return { written: false, conflict: false };
  }

  atomicReplace(filePath, content, encoding);
  return { written: true, conflict: false };
}
