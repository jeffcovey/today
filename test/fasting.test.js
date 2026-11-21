import { jest } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { clearConfigCache } from '../src/config.js';
import { getCurrentFast, getLastFastEnd, startFast, stopFast } from '../src/fasting.js';

describe('fasting storage', () => {
  let workDir;
  let vaultPath;
  let previousConfig;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'today-fasting-'));
    vaultPath = path.join(workDir, 'vault');
    previousConfig = process.env.TODAY_CONFIG;
    const relativeVaultPath = path.relative(path.resolve('src/..'), vaultPath);
    const configPath = path.join(workDir, 'config.toml');
    await fs.writeFile(configPath, `vault_path = "${relativeVaultPath}"\ntimezone = "America/New_York"\n`);
    process.env.TODAY_CONFIG = configPath;
    clearConfigCache();
  });

  afterEach(async () => {
    if (previousConfig === undefined) delete process.env.TODAY_CONFIG;
    else process.env.TODAY_CONFIG = previousConfig;
    clearConfigCache();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test('creates fasting storage and refuses to replace an active fast', async () => {
    const startTime = '2026-11-20T12:00:00-05:00';
    await startFast(startTime);

    await expect(startFast('2026-11-21T12:00:00-05:00')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(getCurrentFast()).resolves.toEqual({ startTime });
  });

  test('serializes concurrent starts and stops so a fast is logged once', async () => {
    const starts = await Promise.allSettled([
      startFast('2026-11-20T12:00:00-05:00'),
      startFast('2026-11-21T12:00:00-05:00')
    ]);
    expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(starts.filter(result => result.status === 'rejected')).toHaveLength(1);

    const results = await Promise.allSettled([stopFast(), stopFast()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const log = await fs.readFile(path.join(vaultPath, 'logs/fasting/2026-11.md'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(1);
  });

  test('keeps the active state when appending the completed log fails', async () => {
    await startFast('2026-11-20T12:00:00-05:00');
    const appendSpy = jest.spyOn(fs, 'appendFile').mockRejectedValue(new Error('disk unavailable'));

    try {
      await expect(stopFast()).rejects.toThrow('disk unavailable');
      await expect(getCurrentFast()).resolves.toEqual({ startTime: '2026-11-20T12:00:00-05:00' });
    } finally {
      appendSpy.mockRestore();
    }
  });

  test('uses the configured timezone month for logs', async () => {
    await startFast('2026-12-01T04:30:00Z');
    await stopFast();

    await expect(fs.access(path.join(vaultPath, 'logs/fasting/2026-11.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(vaultPath, 'logs/fasting/2026-12.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('finds the latest valid end timestamp across monthly logs', async () => {
    const logDir = path.join(vaultPath, 'logs/fasting');
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, '2026-11.md'), [
      '2026-11-30T10:00:00-05:00|2026-11-30T18:00:00-05:00|16',
      'bad|not-a-date|16'
    ].join('\n'));
    await fs.writeFile(path.join(logDir, '2026-12.md'),
      '2026-11-30T23:30:00-05:00|2026-12-01T08:00:00-05:00|16\n');

    await expect(getLastFastEnd()).resolves.toBe('2026-12-01T08:00:00-05:00');
  });

  test('rejects invalid timestamps and goals', async () => {
    await expect(startFast('not-a-date')).rejects.toThrow('startTime');
    await expect(startFast(1720000000000)).rejects.toThrow('startTime');
    await expect(stopFast(-1)).rejects.toThrow('goalHours');
    await expect(stopFast('16')).rejects.toThrow('goalHours');
  });
});
