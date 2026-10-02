import { jest } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { VaultFileIndex } from '../src/vault-file-index.js';

async function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

describe('VaultFileIndex', () => {
  let vault;
  let clock;
  const now = () => clock;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-file-index-'));
    clock = 1000;
    await writeFile(vault, 'projects/alpha.md', '---\nstatus: active\n---\n# Alpha\n');
    await writeFile(vault, 'notes.md', '# No frontmatter\n');
    await writeFile(vault, '.obsidian/hidden.md', '---\nstatus: hidden\n---\n');
    await writeFile(vault, 'projects/readme.txt', 'not markdown');
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  test('indexes markdown files with their frontmatter, skipping hidden directories', async () => {
    const files = await new VaultFileIndex(vault, { now }).get();
    const byPath = Object.fromEntries(files.map(f => [f.path, f]));

    expect(Object.keys(byPath).sort()).toEqual(['notes.md', 'projects/alpha.md']);
    expect(byPath['projects/alpha.md']).toMatchObject({
      status: 'active',
      name: 'alpha',
      folder: 'projects',
      frontmatter: { status: 'active' },
      file: { path: 'projects/alpha.md', name: 'alpha', folder: 'projects' }
    });
    expect(byPath['notes.md']).toMatchObject({ folder: '.', frontmatter: {} });
  });

  test('concurrent first requests share one scan', async () => {
    const index = new VaultFileIndex(vault, { now });
    const rebuild = jest.spyOn(index, 'rebuild');
    const [a, b] = await Promise.all([index.get(), index.get()]);
    expect(a).toBe(b);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  test('a stale index is returned immediately and refreshed in the background', async () => {
    const index = new VaultFileIndex(vault, { now, maxAgeMs: 100 });
    const first = await index.get();

    await writeFile(vault, 'projects/beta.md', '---\nstatus: planning\n---\n');
    clock += 50;
    expect(await index.get()).toBe(first); // still fresh: no rescan

    clock += 100;
    expect(await index.get()).toBe(first); // stale: served as-is...
    await index.refreshing;               // ...while the refresh finishes
    const refreshed = await index.get();
    expect(refreshed.map(f => f.path)).toContain('projects/beta.md');
  });

  test('refresh re-reads only changed files and drops deleted ones', async () => {
    const index = new VaultFileIndex(vault, { now });
    const first = await index.get();
    expect(first.map(f => f.path)).toContain('notes.md');

    await writeFile(vault, 'projects/alpha.md', '---\nstatus: completed\n---\n# Alpha, done\n');
    await fs.rm(path.join(vault, 'notes.md'));
    await writeFile(vault, 'notes2.md', '# New\n');
    const updated = await index.refresh();
    expect(updated.map(f => f.path).sort()).toEqual(['notes2.md', 'projects/alpha.md']);
    expect(updated.find(f => f.path === 'projects/alpha.md').status).toBe('completed');

    // An untouched file keeps its record object rather than being re-parsed
    const again = await index.refresh();
    expect(again.find(f => f.path === 'notes2.md')).toBe(updated.find(f => f.path === 'notes2.md'));
  });

  test('a failed background refresh keeps serving the old index', async () => {
    const errors = [];
    const index = new VaultFileIndex(vault, { now, maxAgeMs: 0, onError: e => errors.push(e) });
    const first = await index.get();

    jest.spyOn(index, 'rebuild').mockRejectedValueOnce(new Error('boom'));
    expect(await index.get()).toBe(first);
    await new Promise(resolve => setImmediate(resolve));
    expect(errors.map(e => e.message)).toEqual(['boom']);
    expect(index.refreshing).toBeNull();
  });
});
