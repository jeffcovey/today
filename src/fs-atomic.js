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
 */

import fs from 'fs';
import path from 'path';

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
