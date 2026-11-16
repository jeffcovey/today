import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const readScript = path.join(repoRoot, 'plugins', 'user-scripts', 'read.js');

describe('user-scripts read plugin', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'user-scripts-read-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('uses VAULT_PATH for the default scripts directory and passes the absolute vault path to child scripts', () => {
    const relativeVaultPath = 'custom-vault';
    const scriptsDir = path.join(tempRoot, relativeVaultPath, 'scripts', 'user-scripts');
    const childScript = path.join(scriptsDir, 'print-vault-path.js');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(childScript, `#!/usr/bin/env node
console.log(process.env.VAULT_PATH);
`);
    fs.chmodSync(childScript, 0o755);

    const result = spawnSync('node', [readScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PROJECT_ROOT: tempRoot,
        VAULT_PATH: relativeVaultPath,
        SOURCE_ID: 'user-scripts/test',
        PLUGIN_CONFIG: JSON.stringify({})
      }
    });

    expect(result.status).toBe(0);
    const output = JSON.parse((result.stdout || '').trim());
    expect(output.message).toMatch(/1 of 1 script ran successfully/);
    expect(output.scripts).toHaveLength(1);
    expect(output.scripts[0].success).toBe(true);
    expect(output.scripts[0].output).toBe(path.join(tempRoot, relativeVaultPath));
  });

  describe('context-only mode', () => {
    function runContextOnly(config, vault = 'vault') {
      const result = spawnSync('node', [readScript], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PROJECT_ROOT: tempRoot,
          VAULT_PATH: vault,
          SOURCE_ID: 'user-scripts/test',
          CONTEXT_ONLY: 'true',
          PLUGIN_CONFIG: JSON.stringify(config)
        }
      });
      expect(result.status).toBe(0);
      return { output: JSON.parse((result.stdout || '').trim()), stderr: result.stderr };
    }

    test('runs no scripts and returns the context files as context', () => {
      const vaultDir = path.join(tempRoot, 'vault');
      const scriptsDir = path.join(vaultDir, 'scripts', 'user-scripts');
      fs.mkdirSync(path.join(vaultDir, 'today', 'context'), { recursive: true });
      fs.mkdirSync(scriptsDir, { recursive: true });
      const marker = path.join(tempRoot, 'ran');
      fs.writeFileSync(path.join(scriptsDir, 'touch.sh'), `#!/bin/sh\ntouch ${marker}\n`);
      fs.chmodSync(path.join(scriptsDir, 'touch.sh'), 0o755);
      fs.writeFileSync(path.join(vaultDir, 'today', 'context', 'a.md'), 'Reading challenge: 52 of 70 books.\n');
      fs.writeFileSync(path.join(vaultDir, 'b.md'), 'Second file.');

      const { output } = runContextOnly({ context_files: ['today/context/a.md', 'missing.md', 'b.md'] });

      expect(fs.existsSync(marker)).toBe(false);
      expect(output.ran).toBe(0);
      expect(output.context).toBe('Reading challenge: 52 of 70 books.\n\nSecond file.');
    });

    test('refuses files outside the vault', () => {
      fs.mkdirSync(path.join(tempRoot, 'vault'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, '.env'), 'SECRET=1');

      const { output, stderr } = runContextOnly({ context_files: ['../.env', '/etc/hostname'] });

      expect(output.context).toBe('');
      expect(stderr).toMatch(/\.\.\/\.env: refused, outside the vault/);
    });

    test('refuses symlinks that lead outside the vault, file or directory', () => {
      const vaultDir = path.join(tempRoot, 'vault');
      const outside = path.join(tempRoot, 'outside');
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET');
      fs.writeFileSync(path.join(vaultDir, 'ok.md'), 'fine');
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(vaultDir, 'file-link.md'));
      fs.symlinkSync(outside, path.join(vaultDir, 'dir-link'));
      fs.symlinkSync(path.join(vaultDir, 'ok.md'), path.join(vaultDir, 'inside-link.md'));

      const { output, stderr } = runContextOnly({ context_files: ['file-link.md', 'dir-link/secret.md', 'inside-link.md'] });

      expect(output.context).toBe('fine');
      expect(stderr).toMatch(/file-link\.md: refused, links outside the vault/);
      expect(stderr).toMatch(/dir-link\/secret\.md: refused, links outside the vault/);
    });

    test('reads through a symlinked vault root', () => {
      const realVault = path.join(tempRoot, 'real-vault');
      fs.mkdirSync(realVault, { recursive: true });
      fs.writeFileSync(path.join(realVault, 'a.md'), 'from the real vault');
      fs.symlinkSync(realVault, path.join(tempRoot, 'vault'));

      const { output } = runContextOnly({ context_files: ['a.md'] });

      expect(output.context).toBe('from the real vault');
    });

    test('reads names that only start with two dots', () => {
      const vaultDir = path.join(tempRoot, 'vault');
      fs.mkdirSync(path.join(vaultDir, '..context'), { recursive: true });
      fs.writeFileSync(path.join(vaultDir, '..reading.md'), 'one');
      fs.writeFileSync(path.join(vaultDir, '..context', 'b.md'), 'two');

      const { output } = runContextOnly({ context_files: ['..reading.md', '..context/b.md'] });

      expect(output.context).toBe('one\n\ntwo');
    });

    test('cuts a long file at 8 KB', () => {
      const vaultDir = path.join(tempRoot, 'vault');
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(path.join(vaultDir, 'big.md'), 'x'.repeat(20000));

      const { output } = runContextOnly({ context_files: ['big.md'] });

      expect(output.context.startsWith('x'.repeat(8192))).toBe(true);
      expect(output.context).toMatch(/big\.md truncated at 8 KB/);
    });

    test('returns empty context when no files are listed', () => {
      const { output } = runContextOnly({});
      expect(output.context).toBe('');
      expect(output.message).toMatch(/context-only/);
    });
  });
});
