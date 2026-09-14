import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execSync = jest.fn();
const spawnSync = jest.fn();
const spawn = jest.fn();
const exec = jest.fn();
const execFileSync = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  exec,
  execFileSync,
  execSync,
  spawn,
  spawnSync
}));

jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn().mockReturnValue({}),
  getVaultPath: jest.fn().mockReturnValue('vault'),
  getAbsoluteVaultPath: jest.fn().mockReturnValue('/tmp/test-vault'),
  getConfigPath: jest.fn().mockReturnValue('config.toml'),
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');
const baselineEnvMtimeMs = fs.existsSync(envPath) ? fs.statSync(envPath).mtimeMs : null;

const { injectDecryptedSettings } = await import('../src/plugin-loader.js');

describe('injectDecryptedSettings', () => {
  const envVarName = 'TODAY_TEST_PLUGIN_DEFAULT_SECRET';
  const plugin = {
    name: 'test-plugin',
    settings: {
      secret: { encrypted: true }
    }
  };
  let originalSecret;

  beforeEach(() => {
    originalSecret = process.env[envVarName];
    execSync.mockReset();
    spawnSync.mockReset();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env[envVarName];
    } else {
      process.env[envVarName] = originalSecret;
    }
  });

  test('uses process.env without shelling out when .env is unchanged', () => {
    process.env[envVarName] = 'from-env';

    const injected = injectDecryptedSettings(plugin, 'default', {});

    expect(injected.secret).toBe('from-env');
    expect(execSync).not.toHaveBeenCalled();
  });

  test('refreshes a stale process.env secret after .env changes, then reuses it', () => {
    process.env[envVarName] = 'stale-env';
    execSync.mockReturnValue('fresh-dotenvx\n');

    const changedEnvMtimeMs = baselineEnvMtimeMs === null ? 1 : baselineEnvMtimeMs + 1;
    const realStatSync = fs.statSync.bind(fs);
    jest.spyOn(fs, 'statSync').mockImplementation((filePath, ...args) => (
      filePath === envPath
        ? { mtimeMs: changedEnvMtimeMs }
        : realStatSync(filePath, ...args)
    ));

    const firstInjected = injectDecryptedSettings(plugin, 'default', {});
    const secondInjected = injectDecryptedSettings(plugin, 'default', {});

    expect(firstInjected.secret).toBe('fresh-dotenvx');
    expect(secondInjected.secret).toBe('fresh-dotenvx');
    expect(process.env[envVarName]).toBe('fresh-dotenvx');
    expect(execSync).toHaveBeenCalledTimes(1);
  });
});
