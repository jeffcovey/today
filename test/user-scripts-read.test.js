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
});
