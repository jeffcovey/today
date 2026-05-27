/**
 * Tests for the create_file AI tool's compare-and-swap behavior.
 *
 * Regression coverage for the umbrella vault-damage fix (#297). The tool
 * previously did `fs.access` then `fs.writeFile`, a TOCTOU window where a
 * separate writer could create the file in between and silently get
 * clobbered. The fix uses writeFileAtomicCASAsync with a null baseline
 * (meaning "expect no file") so a concurrent creation is reported as a
 * conflict instead.
 */

import { jest } from '@jest/globals';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

let tempVault;
jest.unstable_mockModule('../src/config.js', () => ({
  getAbsoluteVaultPath: () => tempVault,
  getFullConfig: () => ({}),
}));

const { createCreateFileTool } = await import('../src/ai-chat/tools.js');

describe('create_file tool CAS behavior', () => {
  beforeEach(() => {
    tempVault = fsSync.mkdtempSync(path.join(os.tmpdir(), 'create-file-cas-'));
  });

  afterEach(() => {
    fsSync.rmSync(tempVault, { recursive: true, force: true });
  });

  test('happy path: creates a new file under a new directory', async () => {
    const result = await createCreateFileTool().execute({
      filePath: 'projects/attachments/letter.html',
      content: '<p>hello</p>',
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe('projects/attachments/letter.html');
    const onDisk = await fs.readFile(
      path.join(tempVault, 'projects/attachments/letter.html'),
      'utf-8',
    );
    expect(onDisk).toBe('<p>hello</p>');
  });

  test('refuses to overwrite an existing file', async () => {
    const existing = path.join(tempVault, 'notes.md');
    await fs.writeFile(existing, 'pre-existing content\n');

    const result = await createCreateFileTool().execute({
      filePath: 'notes.md',
      content: 'new content\n',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
    // Original content untouched.
    expect(await fs.readFile(existing, 'utf-8')).toBe('pre-existing content\n');
  });

  test('rejects paths that escape the vault', async () => {
    const result = await createCreateFileTool().execute({
      filePath: '../outside.md',
      content: 'malicious\n',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the vault/i);
  });

  test('strips a leading slash on the requested path', async () => {
    const result = await createCreateFileTool().execute({
      filePath: '/inbox/new.md',
      content: 'body\n',
    });

    expect(result.success).toBe(true);
    expect(
      await fs.readFile(path.join(tempVault, 'inbox/new.md'), 'utf-8'),
    ).toBe('body\n');
  });
});
