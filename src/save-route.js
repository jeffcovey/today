/**
 * POST /save/*path handler factory.
 *
 * Extracted from web-server.js so the If-Match/CAS contract can be exercised
 * in unit tests without booting the full app. See issue #293.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { writeFileAtomicCASAsync } from './fs-atomic.js';

/**
 * @param {object} opts
 * @param {string} opts.vaultPath - Absolute path to the vault root.
 * @param {(filePath: string) => (void | Promise<void>)} [opts.postWriteHook]
 *   Optional hook fired after a successful write — used by the live server to
 *   log; tests can pass a recorder.
 */
export function createSaveHandler({ vaultPath, postWriteHook } = {}) {
  if (!vaultPath) throw new Error('createSaveHandler: vaultPath is required');

  return async function saveHandler(req, res) {
    try {
      const rawPath = Array.isArray(req.params.path)
        ? req.params.path.join('/')
        : req.params.path;
      // Strip leading slashes so the splat is always treated as a
      // vault-relative path. Without this, a leading slash (e.g. from a
      // double-slash URL like /edit//notes/x) makes path.resolve below treat
      // the arg as absolute and escape the vault, yielding a spurious 403.
      const urlPath = rawPath.replace(/^\/+/, '');
      // Resolve the full path and ensure it is contained within the vault.
      // Using path.resolve (rather than path.join) collapses any `..` segments
      // before the check, and requiring the sep suffix prevents the
      // vault-prefix sibling bypass (e.g. /tmp/vault2 vs /tmp/vault).
      let fullPath = path.resolve(vaultPath, urlPath);
      const vaultRoot = vaultPath.endsWith(path.sep) ? vaultPath : vaultPath + path.sep;

      // Security: prevent directory traversal
      if (fullPath !== vaultPath && !fullPath.startsWith(vaultRoot)) {
        return res.status(403).send('Access denied');
      }

      // If path has no extension, try adding .md (Obsidian-style URLs)
      if (!path.extname(urlPath)) {
        fullPath = fullPath + '.md';
        if (fullPath !== vaultPath && !fullPath.startsWith(vaultRoot)) {
          return res.status(403).send('Access denied');
        }
      }

      const stats = await fs.stat(fullPath);
      if (!stats.isFile() || (!fullPath.endsWith('.md') && !fullPath.endsWith('.toml'))) {
        return res.status(400).send('Can only save markdown and TOML files');
      }

      const { content } = req.body;

      // Optional If-Match contract: when the editor was rendered, it embedded
      // a SHA-256 of the on-disk content and sends it back as X-If-Match-Sha256
      // on save. If the on-disk hash differs, refuse the write so we don't
      // clobber a concurrent edit.
      const ifMatch = req.get('X-If-Match-Sha256');
      let currentContent = null;
      try {
        currentContent = await fs.readFile(fullPath, 'utf-8');
      } catch {
        // File vanished between stat() and readFile() — fall through; the
        // CAS write below treats currentContent === null as "must not exist"
        // and will conflict if the file is recreated under us.
      }

      if (ifMatch && currentContent !== null) {
        const actualSha256 = crypto.createHash('sha256').update(currentContent).digest('hex');
        if (actualSha256 !== ifMatch) {
          return res.status(409).json({
            success: false,
            conflict: true,
            message: 'File changed externally since you opened it.',
            expectedSha256: ifMatch,
            actualSha256,
          });
        }
      }

      // CAS guards the narrow window between the readFile above and the
      // rename below, even when If-Match wasn't supplied.
      const { conflict } = await writeFileAtomicCASAsync(fullPath, content, currentContent);
      if (conflict) {
        return res.status(409).json({
          success: false,
          conflict: true,
          message: 'File changed externally during save.',
        });
      }

      if (postWriteHook) {
        try { await postWriteHook(fullPath); } catch { /* ignore */ }
      }
      res.json({ success: true, message: 'File saved successfully' });
    } catch (error) {
      console.error('Error saving file:', error);
      res.status(500).json({ success: false, message: 'Failed to save file' });
    }
  };
}
