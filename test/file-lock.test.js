import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { appendRoleReport } from '../plugins/roles/block-writer.js';

const lockModuleUrl = pathToFileURL(path.resolve('src/file-lock.js')).href;

describe('shared role and plan-file locking', () => {
  test('a role report waits for a concurrent plan rewrite and preserves both writes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-role-lock-'));
    const filePath = path.join(directory, 'plan.md');
    const readyPath = path.join(directory, 'ready');
    fs.writeFileSync(filePath, [
      '---',
      'cssclasses: plan',
      '---',
      '',
      '<!-- ROLE:secretary:START -->',
      '## 🤖 Secretary',
      '',
      '### 08:00',
      '',
      'Existing entry.',
      '<!-- ROLE:secretary:END -->',
      ''
    ].join('\n'));
    const script = `
      import fs from 'node:fs';
      import { withFileLocks } from ${JSON.stringify(lockModuleUrl)};
      const file = process.argv[1];
      const ready = process.argv[2];
      withFileLocks([file], () => {
        const original = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(ready, 'locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        fs.writeFileSync(file, original + '\\nPlan rewrite.\\n');
      });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, filePath, readyPath], { stdio: 'ignore' });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Child exited ${code}`)));
    });

    try {
      for (let attempt = 0; attempt < 100 && !fs.existsSync(readyPath); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(readyPath)).toBe(true);
      const report = appendRoleReport(filePath, 'secretary', 'Concurrent role report', { time: '09:00' });
      expect(report.ok).toBe(true);
      await exited;
      const result = fs.readFileSync(filePath, 'utf8');
      expect(result).toContain('Plan rewrite.');
      expect(result).toContain('Concurrent role report');
    } finally {
      child.kill();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
