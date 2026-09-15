import { jest } from '@jest/globals';

const execSync = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  execSync
}));

const {
  clearEnvVar,
  clearEncryptedSettingEnvVars,
  deleteSourceConfig,
  rollbackEncryptedSettingBackups,
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

  test('clearEncryptedSettingEnvVars attempts every encrypted key and reports failures', () => {
    execSync.mockImplementation((command) => {
      if (command.includes('TODAY_TEST_PLUGIN_DEFAULT_API_TOKEN')) {
        throw new Error('boom');
      }
      return '';
    });

    expect(clearEncryptedSettingEnvVars('test-plugin', 'default', {
      api_token: { encrypted: true },
      password: { encrypted: true },
      base_url: { encrypted: false }
    })).toEqual(['TODAY_TEST_PLUGIN_DEFAULT_API_TOKEN']);

    expect(execSync).toHaveBeenCalledTimes(2);
    expect(execSync.mock.calls[0][0]).toContain('TODAY_TEST_PLUGIN_DEFAULT_API_TOKEN');
    expect(execSync.mock.calls[1][0]).toContain('TODAY_TEST_PLUGIN_DEFAULT_PASSWORD');
  });

  test('deleteSourceConfigWithSecrets removes the source after persist and cleanup succeed', () => {
    const config = {
      plugins: {
        test: {
          default: { enabled: true }
        }
      }
    };
    const persist = jest.fn().mockReturnValue(true);
    const clear = jest.fn().mockReturnValue(true);

    expect(deleteSourceConfigWithSecrets(
      config,
      'test',
      'default',
      { secret: { encrypted: true } },
      { persist, clear }
    )).toEqual({ ok: true, stage: null, orphanedEnvVars: [] });

    expect(persist).toHaveBeenCalledWith({ plugins: {} });
    expect(clear).toHaveBeenCalledWith('TODAY_TEST_DEFAULT_SECRET');
    expect(config).toEqual({ plugins: {} });
  });

  test('deleteSourceConfig removes the source without touching secrets', () => {
    const config = {
      plugins: {
        test: {
          default: { enabled: true }
        }
      }
    };

    expect(deleteSourceConfig(config, 'test', 'default')).toBe(true);
    expect(config).toEqual({ plugins: {} });
  });

  test('deleteSourceConfigWithSecrets leaves secrets intact when persist fails', () => {
    const config = {
      plugins: {
        test: {
          default: { enabled: true }
        }
      }
    };
    const persist = jest.fn().mockReturnValue(false);
    const clear = jest.fn();

    expect(deleteSourceConfigWithSecrets(
      config,
      'test',
      'default',
      { secret: { encrypted: true } },
      { persist, clear }
    )).toEqual({ ok: false, stage: 'persist', orphanedEnvVars: [] });

    expect(clear).not.toHaveBeenCalled();
    expect(config).toEqual({ plugins: {} });
  });

  test('deleteSourceConfigWithSecrets reports orphaned secrets when cleanup fails after persist', () => {
    const config = {
      plugins: {
        test: {
          default: { enabled: true }
        }
      }
    };
    const persist = jest.fn().mockReturnValue(true);
    const clear = jest.fn().mockReturnValue(false);

    expect(deleteSourceConfigWithSecrets(
      config,
      'test',
      'default',
      { secret: { encrypted: true } },
      { persist, clear }
    )).toEqual({
      ok: false,
      stage: 'clear',
      orphanedEnvVars: ['TODAY_TEST_DEFAULT_SECRET']
    });

    expect(persist).toHaveBeenCalledWith({ plugins: {} });
    expect(clear).toHaveBeenCalledWith('TODAY_TEST_DEFAULT_SECRET');
    expect(config).toEqual({ plugins: {} });
  });

  test('rollbackEncryptedSettingBackups reports failed restores and clears', () => {
    const clear = jest.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const set = jest.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const backups = new Map([
      ['TODAY_TEST_PLUGIN_DEFAULT_REMOVE_ME', null],
      ['TODAY_TEST_PLUGIN_DEFAULT_RESTORE_ME', 'before'],
      ['TODAY_TEST_PLUGIN_DEFAULT_OK_REMOVE', null],
      ['TODAY_TEST_PLUGIN_DEFAULT_OK_RESTORE', 'after']
    ]);

    expect(rollbackEncryptedSettingBackups(backups, { clear, set })).toEqual([
      'TODAY_TEST_PLUGIN_DEFAULT_REMOVE_ME',
      'TODAY_TEST_PLUGIN_DEFAULT_RESTORE_ME'
    ]);

    expect(clear).toHaveBeenNthCalledWith(1, 'TODAY_TEST_PLUGIN_DEFAULT_REMOVE_ME');
    expect(set).toHaveBeenNthCalledWith(1, 'TODAY_TEST_PLUGIN_DEFAULT_RESTORE_ME', 'before');
    expect(clear).toHaveBeenNthCalledWith(2, 'TODAY_TEST_PLUGIN_DEFAULT_OK_REMOVE');
    expect(set).toHaveBeenNthCalledWith(2, 'TODAY_TEST_PLUGIN_DEFAULT_OK_RESTORE', 'after');
  });
});
