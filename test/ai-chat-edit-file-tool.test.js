/**
 * Tests for the edit_file AI tool's compare-and-swap behavior.
 *
 * Regression coverage for #291: the tool used to do a read-modify-write
 * with plain fs.writeFile, so a concurrent edit between the read and the
 * write was silently overwritten. The fix uses writeFileAtomicCASAsync
 * with currentContent as the baseline, returning conflict to the AI
 * runner so it can re-read and retry.
 */

import { jest } from '@jest/globals';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

// Mock the config module so getAbsoluteVaultPath returns our temp dir.
let tempVault;
jest.unstable_mockModule('../src/config.js', () => ({
  getAbsoluteVaultPath: () => tempVault,
  getFullConfig: () => ({}),
}));

const { createEditFileTool } = await import('../src/ai-chat/tools.js');

describe('edit_file tool CAS behavior', () => {
  let filePath;

  beforeEach(() => {
    tempVault = fsSync.mkdtempSync(path.join(os.tmpdir(), 'edit-file-cas-'));
    filePath = path.join(tempVault, 'notes', 'plan.md');
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  });

  afterEach(() => {
    fsSync.rmSync(tempVault, { recursive: true, force: true });
  });

  test('happy path: applies a single replacement and reports success', async () => {
    await fs.writeFile(filePath, 'Hello, world!\n');

    const result = await createEditFileTool(filePath).execute({
      oldText: 'world',
      newText: 'universe',
    });

    expect(result.success).toBe(true);
    expect(result.replacementsMade).toBe(1);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('Hello, universe!\n');
  });

  test('reports conflict instead of clobbering when file changes mid-edit', async () => {
    await fs.writeFile(filePath, 'original baseline\n');

    // Spy on fs.readFile so we can simulate a concurrent writer that
    // modifies the file AFTER the tool reads currentContent but BEFORE the
    // CAS write attempts the atomic rename.
    const realReadFile = fs.readFile.bind(fs);
    const spy = jest.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
      const value = await realReadFile(...args);
      // Concurrent writer wins the race: rewrites the file under us.
      await realReadFile(filePath, 'utf-8'); // settle
      fsSync.writeFileSync(filePath, 'concurrent edit\n');
      return value;
    });

    const result = await createEditFileTool(filePath).execute({
      oldText: 'original',
      newText: 'mine',
    });

    spy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    // The concurrent edit is preserved untouched.
    expect(await fs.readFile(filePath, 'utf-8')).toBe('concurrent edit\n');
  });

  test('refuses replaceAll-less call when oldText appears multiple times', async () => {
    await fs.writeFile(filePath, 'foo bar foo baz\n');

    const result = await createEditFileTool(filePath).execute({
      oldText: 'foo',
      newText: 'qux',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('2 times');
    // File untouched.
    expect(await fs.readFile(filePath, 'utf-8')).toBe('foo bar foo baz\n');
  });

  test('replaceAll: true applies and CAS-protects multi-occurrence edits', async () => {
    await fs.writeFile(filePath, 'foo bar foo baz\n');

    const result = await createEditFileTool(filePath).execute({
      oldText: 'foo',
      newText: 'qux',
      replaceAll: true,
    });

    expect(result.success).toBe(true);
    expect(result.replacementsMade).toBe(2);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('qux bar qux baz\n');
  });
});
