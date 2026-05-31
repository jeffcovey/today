import { jest } from '@jest/globals';

// Mock the config module before importing ai-provider
jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn(),
  getConfig: jest.fn(),
}));

const { getFullConfig } = await import('../src/config.js');
const {
  clearProviderCache,
  isAIAvailable,
  getProviderName,
  getInteractiveProviderName,
  getInteractiveModel,
  getConfiguredModelName,
  checkProviderBinarySync,
} = await import('../src/ai-provider.js');

const { existsSync } = await import('fs');
const { homedir } = await import('os');
const { join } = await import('path');
const { spawnSync } = await import('child_process');

describe('AI Provider (Vercel AI SDK)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearProviderCache();
    // Reset environment variables
    delete process.env.TODAY_ANTHROPIC_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
  });

  describe('getProviderName', () => {
    test('returns default provider name (anthropic)', () => {
      getFullConfig.mockReturnValue({});

      expect(getProviderName()).toBe('anthropic');
    });

    test('returns configured provider name', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'ollama' }
      });

      expect(getProviderName()).toBe('ollama');
    });

    test('returns openai when configured', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'openai' }
      });

      expect(getProviderName()).toBe('openai');
    });

    test('returns google when configured', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'google' }
      });

      expect(getProviderName()).toBe('google');
    });
  });

  describe('getInteractiveProviderName', () => {
    test('returns default interactive provider (anthropic)', () => {
      getFullConfig.mockReturnValue({});

      expect(getInteractiveProviderName()).toBe('anthropic');
    });

    test('returns configured interactive provider', () => {
      getFullConfig.mockReturnValue({
        ai: { interactive_provider: 'openai' }
      });

      expect(getInteractiveProviderName()).toBe('openai');
    });
  });

  describe('getInteractiveModel', () => {
    test('returns default interactive model based on provider', () => {
      getFullConfig.mockReturnValue({});

      expect(getInteractiveModel()).toBe('claude-sonnet-4-6');
    });

    test('returns default model for anthropic-api provider', () => {
      getFullConfig.mockReturnValue({
        ai: { interactive_provider: 'anthropic-api' }
      });

      expect(getInteractiveModel()).toBe('claude-sonnet-4-6');
    });

    test('returns default model for ollama provider', () => {
      getFullConfig.mockReturnValue({
        ai: { interactive_provider: 'ollama' }
      });

      expect(getInteractiveModel()).toBe('llama3.2');
    });

    test('returns configured interactive model', () => {
      getFullConfig.mockReturnValue({
        ai: { interactive_model: 'claude-opus-4-20250514' }
      });

      expect(getInteractiveModel()).toBe('claude-opus-4-20250514');
    });
  });

  describe('getConfiguredModelName', () => {
    test('returns model from config', () => {
      getFullConfig.mockReturnValue({
        ai: { model: 'gpt-4o' }
      });

      expect(getConfiguredModelName()).toBe('gpt-4o');
    });

    test('returns default model for anthropic', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'anthropic' }
      });

      expect(getConfiguredModelName()).toBe('claude-sonnet-4-6');
    });

    test('returns default model for openai', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'openai' }
      });

      expect(getConfiguredModelName()).toBe('gpt-4o');
    });

    test('returns default model for google', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'google' }
      });

      expect(getConfiguredModelName()).toBe('gemini-1.5-flash');
    });

    test('returns default model for ollama', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'ollama' }
      });

      expect(getConfiguredModelName()).toBe('llama3.2');
    });
  });

  describe('isAIAvailable', () => {
    test('anthropic-api: returns true when API key is set via TODAY_ANTHROPIC_KEY', async () => {
      process.env.TODAY_ANTHROPIC_KEY = 'test-key';
      getFullConfig.mockReturnValue({ ai: { provider: 'anthropic-api' } });

      expect(await isAIAvailable()).toBe(true);
    });

    test('anthropic-api: returns true when API key is set via ANTHROPIC_API_KEY', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      getFullConfig.mockReturnValue({ ai: { provider: 'anthropic-api' } });

      expect(await isAIAvailable()).toBe(true);
    });

    test('anthropic-api: returns false when no API key is set', async () => {
      getFullConfig.mockReturnValue({ ai: { provider: 'anthropic-api' } });

      expect(await isAIAvailable()).toBe(false);
    });

    test('anthropic (CLI): availability tracks the claude binary, not an API key', async () => {
      // The default provider is 'anthropic', which runs the local Claude CLI.
      getFullConfig.mockReturnValue({});
      const expected = checkProviderBinarySync('anthropic', spawnSync).available;

      expect(await isAIAvailable()).toBe(expected);
    });

    test('anthropic (CLI): an API key does not grant availability without the binary', async () => {
      process.env.TODAY_ANTHROPIC_KEY = 'test-key';
      getFullConfig.mockReturnValue({ ai: { provider: 'anthropic' } });
      const expected = checkProviderBinarySync('anthropic', spawnSync).available;

      // Result follows the binary check regardless of the API key being present.
      expect(await isAIAvailable()).toBe(expected);
    });

    test('returns true when OpenAI API key is set', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      getFullConfig.mockReturnValue({
        ai: { provider: 'openai' }
      });

      const available = await isAIAvailable();

      expect(available).toBe(true);
    });

    test('returns false when no API key is set for OpenAI', async () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'openai' }
      });

      const available = await isAIAvailable();

      expect(available).toBe(false);
    });

    test('returns true when Google API key is set', async () => {
      process.env.GOOGLE_API_KEY = 'test-key';
      getFullConfig.mockReturnValue({
        ai: { provider: 'google' }
      });

      const available = await isAIAvailable();

      expect(available).toBe(true);
    });

    test('returns true when Gemini API key is set', async () => {
      process.env.GEMINI_API_KEY = 'test-key';
      getFullConfig.mockReturnValue({
        ai: { provider: 'gemini' }
      });

      const available = await isAIAvailable();

      expect(available).toBe(true);
    });

    test('returns false when no API key is set for Google', async () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'google' }
      });

      const available = await isAIAvailable();

      expect(available).toBe(false);
    });

    // Ollama availability check makes a network request, so we skip it in unit tests
    // It would be tested in integration tests
  });

  describe('clearProviderCache', () => {
    test('can be called without error', () => {
      expect(() => clearProviderCache()).not.toThrow();
    });
  });

  describe('checkProviderBinarySync', () => {
    test('returns available with no requirement for API-only providers', () => {
      const spawnSync = jest.fn();
      const result = checkProviderBinarySync('anthropic-api', spawnSync);
      expect(result).toEqual({ available: true });
      expect(spawnSync).not.toHaveBeenCalled();
    });

    test('returns resolved path when `which` finds the binary', () => {
      const spawnSync = jest.fn().mockReturnValue({ status: 0, stdout: '/usr/local/bin/claude\n' });
      const result = checkProviderBinarySync('anthropic', spawnSync);
      expect(result.available).toBe(true);
      expect(result.binaryPath).toBe('/usr/local/bin/claude');
      expect(result.requirement.binary).toBe('claude');
    });

    test('falls back to ~/.local/bin when `which` fails but binary exists there', () => {
      const localBinPath = join(homedir(), '.local', 'bin', 'claude');
      const exists = existsSync(localBinPath);
      const spawnSync = jest.fn().mockReturnValue({ status: 1, stdout: '' });
      const result = checkProviderBinarySync('anthropic', spawnSync);
      if (exists) {
        expect(result.available).toBe(true);
        expect(result.binaryPath).toBe(localBinPath);
      } else {
        expect(result.available).toBe(false);
        expect(result.binaryPath).toBeUndefined();
      }
      expect(result.requirement.binary).toBe('claude');
    });

    test('returns unavailable when binary is missing everywhere', () => {
      const spawnSync = jest.fn().mockReturnValue({ status: 1, stdout: '' });
      const result = checkProviderBinarySync('ollama', spawnSync);
      // ollama is unlikely to be at ~/.local/bin/ollama in CI; assert shape either way
      const localBinPath = join(homedir(), '.local', 'bin', 'ollama');
      if (!existsSync(localBinPath)) {
        expect(result.available).toBe(false);
        expect(result.binaryPath).toBeUndefined();
      }
      expect(result.requirement.binary).toBe('ollama');
    });
  });
});
