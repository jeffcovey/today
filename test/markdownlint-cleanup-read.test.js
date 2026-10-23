import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const readScript = path.join(repoRoot, 'plugins', 'markdownlint-cleanup', 'read.js');

describe('markdownlint-cleanup read plugin', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'markdownlint-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // Regression test for #623: read.js imported 'glob', which was never a
  // declared dependency. On a production install the import threw
  // ERR_MODULE_NOT_FOUND at module load, so the plugin failed on every run.
  // FILE_FILTER keeps this on the targeted path, which touches no database.
  test('loads its dependencies and fixes a targeted file', () => {
    const target = path.join(tempRoot, 'dirty.md');
    fs.writeFileSync(target, '# Title\nText right after a heading.\n* item one\n');

    const result = spawnSync('node', [readScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VAULT_PATH: path.join(tempRoot, 'vault'),
        SOURCE_ID: 'markdownlint-cleanup/test',
        PLUGIN_CONFIG: JSON.stringify({}),
        FILE_FILTER: target
      }
    });

    expect(result.stderr || '').not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(result.status).toBe(0);

    const output = JSON.parse((result.stdout || '').trim());
    expect(output.mode).toBe('targeted');
    expect(output.cleaned).toBe(1);

    // blanks-around-headings (MD022) and MD004 dash style applied.
    // No blank line is inserted before the list: blanks-around-lists is
    // disabled in .markdownlint.json.
    expect(fs.readFileSync(target, 'utf8')).toBe(
      '# Title\n\nText right after a heading.\n- item one\n'
    );
  });

  test('reports nothing to do when the targeted file is already clean', () => {
    const target = path.join(tempRoot, 'clean.md');
    const clean = '# Title\n\nText with a blank line after the heading.\n\n- item one\n';
    fs.writeFileSync(target, clean);

    const result = spawnSync('node', [readScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VAULT_PATH: path.join(tempRoot, 'vault'),
        SOURCE_ID: 'markdownlint-cleanup/test',
        PLUGIN_CONFIG: JSON.stringify({}),
        FILE_FILTER: target
      }
    });

    expect(result.status).toBe(0);
    const output = JSON.parse((result.stdout || '').trim());
    expect(output.cleaned).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(clean);
  });
});
