import { jest } from '@jest/globals';

// Mock the config module before importing ai-provider
jest.unstable_mockModule('../src/config.js', () => ({
  getFullConfig: jest.fn(),
  getConfig: jest.fn(),
}));

const { getFullConfig } = await import('../src/config.js');
const {
  getAIProvider,
  clearProviderCache,
  createCompletion,
  isAIAvailable,
  getProviderName,
  getConfiguredModel,
  AnthropicProvider,
  OpenAIProvider,
  OllamaProvider,
  GeminiProvider,
} = await import('../src/ai-provider.js');

describe('AI Provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearProviderCache();
    // Reset environment variables
    delete process.env.TODAY_ANTHROPIC_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  describe('getAIProvider', () => {
    test('returns Anthropic provider by default', () => {
      getFullConfig.mockReturnValue({});

      const provider = getAIProvider();

      expect(provider).toBeInstanceOf(AnthropicProvider);
      expect(provider.name).toBe('anthropic');
    });

    test('returns configured provider', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'openai' }
      });

      const provider = getAIProvider();

      expect(provider).toBeInstanceOf(OpenAIProvider);
      expect(provider.name).toBe('openai');
    });

    test('returns Ollama provider when configured', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'ollama' }
      });

      const provider = getAIProvider();

      expect(provider).toBeInstanceOf(OllamaProvider);
      expect(provider.name).toBe('ollama');
    });

    test('returns Gemini provider when configured', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'gemini' }
      });

      const provider = getAIProvider();

      expect(provider).toBeInstanceOf(GeminiProvider);
      expect(provider.name).toBe('gemini');
    });

    test('throws error for unknown provider', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'unknown-provider' }
      });

      expect(() => getAIProvider()).toThrow('Unknown AI provider: unknown-provider');
    });

    test('caches provider instance', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'anthropic' }
      });

      const provider1 = getAIProvider();
      const provider2 = getAIProvider();

      expect(provider1).toBe(provider2);
    });

    test('allows override of provider name', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'anthropic' }
      });

      const provider = getAIProvider('openai');

      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    test('passes provider-specific config with snake_case', () => {
      getFullConfig.mockReturnValue({
        ai: {
          provider: 'ollama',
          ollama: {
            base_url: 'http://custom:11434'
          }
        }
      });

      const provider = getAIProvider();

      expect(provider.baseURL).toBe('http://custom:11434');
    });

    test('uses model from config', () => {
      getFullConfig.mockReturnValue({
        ai: {
          provider: 'anthropic',
          model: 'claude-opus-4-20250514'
        }
      });

      const provider = getAIProvider();

      expect(provider.defaultModel).toBe('claude-opus-4-20250514');
    });
  });

  describe('clearProviderCache', () => {
    test('clears cached provider', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'anthropic' }
      });

      const provider1 = getAIProvider();
      clearProviderCache();

      getFullConfig.mockReturnValue({
        ai: { provider: 'openai' }
      });

      const provider2 = getAIProvider();

      expect(provider1).not.toBe(provider2);
      expect(provider2).toBeInstanceOf(OpenAIProvider);
    });
  });

  describe('getProviderName', () => {
    test('returns default provider name', () => {
      getFullConfig.mockReturnValue({});

      expect(getProviderName()).toBe('anthropic');
    });

    test('returns configured provider name', () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'ollama' }
      });

      expect(getProviderName()).toBe('ollama');
    });
  });

  describe('getConfiguredModel', () => {
    test('returns model from config', () => {
      getFullConfig.mockReturnValue({
        ai: { model: 'gpt-4o' }
      });

      expect(getConfiguredModel()).toBe('gpt-4o');
    });

    test('falls back to api_model', () => {
      getFullConfig.mockReturnValue({
        ai: { api_model: 'claude-sonnet-4-20250514' }
      });

      expect(getConfiguredModel()).toBe('claude-sonnet-4-20250514');
    });

    test('falls back to provider default', () => {
      getFullConfig.mockReturnValue({});

      // Default Anthropic provider has default model
      expect(getConfiguredModel()).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('isAIAvailable', () => {
    test('returns true when Anthropic API key is set', async () => {
      process.env.TODAY_ANTHROPIC_KEY = 'test-key';
      getFullConfig.mockReturnValue({});
      clearProviderCache();

      const available = await isAIAvailable();

      expect(available).toBe(true);
    });

    test('returns false when no API key is set for Anthropic', async () => {
      getFullConfig.mockReturnValue({});
      clearProviderCache();

      const available = await isAIAvailable();

      expect(available).toBe(false);
    });

    test('returns true when OpenAI API key is set', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      getFullConfig.mockReturnValue({
        ai: { provider: 'openai' }
      });
      clearProviderCache();

      const available = await isAIAvailable();

      expect(available).toBe(true);
    });

    test('returns false when no API key is set for OpenAI', async () => {
      getFullConfig.mockReturnValue({
        ai: { provider: 'openai' }
      });
      clearProviderCache();

      const available = await isAIAvailable();

      expect(available).toBe(false);
    });
  });

  describe('AnthropicProvider', () => {
    test('uses TODAY_ANTHROPIC_KEY env var', () => {
      process.env.TODAY_ANTHROPIC_KEY = 'today-key';
      process.env.ANTHROPIC_API_KEY = 'fallback-key';

      const provider = new AnthropicProvider({});

      expect(provider.apiKey).toBe('today-key');
    });

    test('falls back to ANTHROPIC_API_KEY', () => {
      process.env.ANTHROPIC_API_KEY = 'fallback-key';

      const provider = new AnthropicProvider({});

      expect(provider.apiKey).toBe('fallback-key');
    });

    test('uses config apiKey over env vars', () => {
      process.env.TODAY_ANTHROPIC_KEY = 'env-key';

      const provider = new AnthropicProvider({ apiKey: 'config-key' });

      expect(provider.apiKey).toBe('config-key');
    });

    test('has correct default model', () => {
      const provider = new AnthropicProvider({});

      expect(provider.defaultModel).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('OpenAIProvider', () => {
    test('uses OPENAI_API_KEY env var', () => {
      process.env.OPENAI_API_KEY = 'openai-key';

      const provider = new OpenAIProvider({});

      expect(provider.apiKey).toBe('openai-key');
    });

    test('has correct default model', () => {
      const provider = new OpenAIProvider({});

      expect(provider.defaultModel).toBe('gpt-4o');
    });

    test('supports custom base URL', () => {
      const provider = new OpenAIProvider({ baseURL: 'https://custom.api.com' });

      expect(provider.baseURL).toBe('https://custom.api.com');
    });
  });

  describe('OllamaProvider', () => {
    test('has correct default base URL', () => {
      const provider = new OllamaProvider({});

      expect(provider.baseURL).toBe('http://localhost:11434');
    });

    test('uses custom base URL from config', () => {
      const provider = new OllamaProvider({ baseURL: 'http://remote:11434' });

      expect(provider.baseURL).toBe('http://remote:11434');
    });

    test('has correct default model', () => {
      const provider = new OllamaProvider({});

      expect(provider.defaultModel).toBe('llama3.2');
    });
  });

  describe('GeminiProvider', () => {
    test('uses GOOGLE_API_KEY env var', () => {
      process.env.GOOGLE_API_KEY = 'google-key';

      const provider = new GeminiProvider({});

      expect(provider.apiKey).toBe('google-key');
    });

    test('falls back to GEMINI_API_KEY', () => {
      process.env.GEMINI_API_KEY = 'gemini-key';

      const provider = new GeminiProvider({});

      expect(provider.apiKey).toBe('gemini-key');
    });

    test('has correct default model', () => {
      const provider = new GeminiProvider({});

      expect(provider.defaultModel).toBe('gemini-1.5-flash');
    });
  });
});
