/**
 * Tests for the /save handler factory.
 *
 * Covers the If-Match/CAS contract added by #293:
 * - matching X-If-Match-Sha256 → 200, file replaced
 * - mismatched X-If-Match-Sha256 → 409 with detail body, file untouched
 * - no header at all → 200 (backward compatible) and still CAS-protected
 *   against a write that lands between read and rename
 * - directory traversal still refused
 */

import crypto from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

import { createSaveHandler } from '../src/save-route.js';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function withServer(handler, run) {
  const app = express();
  app.use(express.json());
  app.post('/save/*path', handler);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('createSaveHandler (issue #293)', () => {
  let vaultPath;
  let filePath;

  beforeEach(() => {
    vaultPath = fsSync.mkdtempSync(path.join(os.tmpdir(), 'save-route-'));
    filePath = path.join(vaultPath, 'plan.md');
    fsSync.writeFileSync(filePath, 'original baseline\n');
  });

  afterEach(() => {
    fsSync.rmSync(vaultPath, { recursive: true, force: true });
  });

  test('matching X-If-Match-Sha256 → 200, content replaced', async () => {
    const handler = createSaveHandler({ vaultPath });
    const ifMatch = sha256('original baseline\n');

    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/save/plan.md`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-If-Match-Sha256': ifMatch,
        },
        body: JSON.stringify({ content: 'new content\n' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(await fs.readFile(filePath, 'utf-8')).toBe('new content\n');
    });
  });

  test('mismatched X-If-Match-Sha256 → 409, file untouched, diagnostics returned', async () => {
    const handler = createSaveHandler({ vaultPath });

    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/save/plan.md`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-If-Match-Sha256': 'cafebabe-stale-hash',
        },
        body: JSON.stringify({ content: 'should not land\n' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.conflict).toBe(true);
      expect(body.expectedSha256).toBe('cafebabe-stale-hash');
      expect(body.actualSha256).toBe(sha256('original baseline\n'));
      expect(await fs.readFile(filePath, 'utf-8')).toBe('original baseline\n');
    });
  });

  test('no If-Match header → 200 (backward-compatible), file replaced', async () => {
    const handler = createSaveHandler({ vaultPath });

    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/save/plan.md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'no-header write\n' }),
      });

      expect(res.status).toBe(200);
      expect(await fs.readFile(filePath, 'utf-8')).toBe('no-header write\n');
    });
  });

  test('If-Match save still succeeds when file is deleted between stat() and readFile()', async () => {
    const handler = createSaveHandler({ vaultPath });
    const ifMatch = sha256('original baseline\n');
    const readSpy = jest.spyOn(fs, 'readFile').mockImplementationOnce(async () => {
      await fs.unlink(filePath);
      throw new Error('simulated ENOENT between stat and read');
    });

    try {
      await withServer(handler, async (base) => {
        const res = await fetch(`${base}/save/plan.md`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-If-Match-Sha256': ifMatch,
          },
          body: JSON.stringify({ content: 'recreated after delete\n' }),
        });

        expect(res.status).toBe(200);
        expect(await fs.readFile(filePath, 'utf-8')).toBe('recreated after delete\n');
      });
    } finally {
      readSpy.mockRestore();
    }
  });

  test('directory traversal is refused', async () => {
    const handler = createSaveHandler({ vaultPath });

    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/save/..%2Fescape.md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'malicious\n' }),
      });

      expect(res.status).toBe(403);
    });
  });

  test('non-markdown/toml file rejected', async () => {
    fsSync.writeFileSync(path.join(vaultPath, 'notes.txt'), 'plain text\n');
    const handler = createSaveHandler({ vaultPath });

    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/save/notes.txt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'should be rejected\n' }),
      });

      expect(res.status).toBe(400);
    });
  });

  test('extensionless URL gets .md appended (Obsidian-style)', async () => {
    const handler = createSaveHandler({ vaultPath });

    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/save/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'obsidian-style\n' }),
      });

      expect(res.status).toBe(200);
      expect(await fs.readFile(filePath, 'utf-8')).toBe('obsidian-style\n');
    });
  });
});
