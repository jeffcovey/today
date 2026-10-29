import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { clearConfigCache, getConfig } from '../src/config.js';

describe('config cache', () => {
  let workDir;
  let configPath;
  let previousConfig;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-config-cache-'));
    configPath = path.join(workDir, 'config.toml');
    previousConfig = process.env.TODAY_CONFIG;
    process.env.TODAY_CONFIG = configPath;
    clearConfigCache();
  });

  afterEach(async () => {
    if (previousConfig === undefined) delete process.env.TODAY_CONFIG;
    else process.env.TODAY_CONFIG = previousConfig;
    clearConfigCache();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test('reloads a config edit when its mtime changes before the cache TTL', async () => {
    await fs.writeFile(configPath, 'cache_test_value = "first"\n');
    const firstMtime = new Date('2026-01-01T00:00:00Z');
    await fs.utimes(configPath, firstMtime, firstMtime);
    expect(getConfig('cache_test_value')).toBe('first');

    await fs.writeFile(configPath, 'cache_test_value = "second value"\n');
    const changedMtime = new Date('2026-01-01T00:00:10Z');
    await fs.utimes(configPath, changedMtime, changedMtime);
    expect(getConfig('cache_test_value')).toBe('second value');
  });
});
