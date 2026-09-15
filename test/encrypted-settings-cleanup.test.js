import { jest } from '@jest/globals';

const execSync = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  execSync
}));

const {
  clearEnvVar,
  clearEncryptedSettings,
  deleteSourceConfigWithSecrets
} = await import('../src/encrypted-settings.js');

describe('encrypted settings cleanup', () => {
  beforeEach(() => {
    execSync.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('clearEnvVar deletes the backing env var with dotenvx del', () => {
    execSync.mockReturnValue('');

    expect(clearEnvVar('TODAY_TEST_PLUGIN_DEFAULT_SECRET')).toBe(true);
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('npx dotenvx del TODAY_TEST_PLUGIN_DEFAULT_SECRET'),
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe']
      })
    );
  });

  test('clearEncryptedSettings attempts every encrypted key and reports failures', () => {
    execSync.mockImplementation((command) => {
      if (command.includes('TODAY_TEST_PLUGIN_DEFAULT_API_TOKEN')) {
        throw new Error('boom');
      }
      return '';
    });

    expect(clearEncryptedSettings('test-plugin', 'default', {
      api_token: { encrypted: true },
      password: { encrypted: true },
      base_url: { encrypted: false }
    })).toBe(false);

    expect(execSync).toHaveBeenCalledTimes(2);
    expect(execSync.mock.calls[0][0]).toContain('TODAY_TEST_PLUGIN_DEFAULT_API_TOKEN');
    expect(execSync.mock.calls[1][0]).toContain('TODAY_TEST_PLUGIN_DEFAULT_PASSWORD');
  });

  test('deleteSourceConfigWithSecrets removes the source after cleanup succeeds', () => {
    const config = {
      plugins: {
        test: {
          default: { enabled: true }
        }
      }
    };
    const clearSettings = jest.fn().mockReturnValue(true);

    expect(deleteSourceConfigWithSecrets(
      config,
      'test',
      'default',
      { secret: { encrypted: true } },
      clearSettings
    )).toBe(true);

    expect(clearSettings).toHaveBeenCalledWith('test', 'default', { secret: { encrypted: true } });
    expect(config).toEqual({ plugins: {} });
  });

  test('deleteSourceConfigWithSecrets aborts deletion when cleanup fails', () => {
    const config = {
      plugins: {
        test: {
          default: { enabled: true }
        }
      }
    };
    const clearSettings = jest.fn().mockReturnValue(false);

    expect(deleteSourceConfigWithSecrets(
      config,
      'test',
      'default',
      { secret: { encrypted: true } },
      clearSettings
    )).toBe(false);

    expect(config).toEqual({
      plugins: {
        test: {
          default: { enabled: true }
        }
      }
    });
  });
});
