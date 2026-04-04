import {
  AI_PROVIDER_ENV_VARS,
  BACKGROUND_PROVIDER_OPTIONS,
  INTERACTIVE_PROVIDER_OPTIONS,
  getModelOptionsForProvider,
  getAiSettingsFields,
} from '../src/ai-settings-shared.js';

describe('ai-settings-shared', () => {
  describe('AI_PROVIDER_ENV_VARS', () => {
    test('contains entries for known providers', () => {
      expect(AI_PROVIDER_ENV_VARS.anthropic).toEqual({ key: 'TODAY_ANTHROPIC_KEY', label: 'Anthropic API Key' });
      expect(AI_PROVIDER_ENV_VARS.openai).toEqual({ key: 'OPENAI_API_KEY', label: 'OpenAI API Key' });
      expect(AI_PROVIDER_ENV_VARS.gemini).toEqual({ key: 'GOOGLE_API_KEY', label: 'Google API Key' });
    });

    test('ollama has no key (local provider)', () => {
      expect(AI_PROVIDER_ENV_VARS.ollama).toBeNull();
    });
  });

  describe('BACKGROUND_PROVIDER_OPTIONS', () => {
    test('is an array of provider objects with value and label', () => {
      expect(Array.isArray(BACKGROUND_PROVIDER_OPTIONS)).toBe(true);
      for (const opt of BACKGROUND_PROVIDER_OPTIONS) {
        expect(opt).toHaveProperty('value');
        expect(opt).toHaveProperty('label');
      }
    });

    test('does not include claude-cli (background tasks use API)', () => {
      const values = BACKGROUND_PROVIDER_OPTIONS.map(o => o.value);
      expect(values).not.toContain('claude-cli');
    });
  });

  describe('INTERACTIVE_PROVIDER_OPTIONS', () => {
    test('includes anthropic and anthropic-api options', () => {
      const values = INTERACTIVE_PROVIDER_OPTIONS.map(o => o.value);
      expect(values).toContain('anthropic');
      expect(values).toContain('anthropic-api');
    });

    test('has more options than background options (includes CLI)', () => {
      expect(INTERACTIVE_PROVIDER_OPTIONS.length).toBeGreaterThanOrEqual(BACKGROUND_PROVIDER_OPTIONS.length);
    });
  });

  describe('getModelOptionsForProvider', () => {
    test('returns Anthropic models for "anthropic"', () => {
      const options = getModelOptionsForProvider('anthropic');
      expect(Array.isArray(options)).toBe(true);
      expect(options.length).toBeGreaterThan(0);
      const values = options.map(o => o.value);
      expect(values.some(v => v.includes('claude'))).toBe(true);
    });

    test('returns Anthropic models for "anthropic-api"', () => {
      const options = getModelOptionsForProvider('anthropic-api');
      expect(Array.isArray(options)).toBe(true);
      const values = options.map(o => o.value);
      expect(values.some(v => v.includes('claude'))).toBe(true);
    });

    test('returns OpenAI models for "openai"', () => {
      const options = getModelOptionsForProvider('openai');
      expect(Array.isArray(options)).toBe(true);
      const values = options.map(o => o.value);
      expect(values.some(v => v.includes('gpt'))).toBe(true);
    });

    test('returns Gemini models for "gemini"', () => {
      const options = getModelOptionsForProvider('gemini');
      expect(Array.isArray(options)).toBe(true);
      const values = options.map(o => o.value);
      expect(values.some(v => v.includes('gemini'))).toBe(true);
    });

    test('returns Gemini models for "google" alias', () => {
      const options = getModelOptionsForProvider('google');
      expect(Array.isArray(options)).toBe(true);
      const values = options.map(o => o.value);
      expect(values.some(v => v.includes('gemini'))).toBe(true);
    });

    test('returns null for unknown provider', () => {
      expect(getModelOptionsForProvider('unknown-provider')).toBeNull();
    });

    test('each option has value and label', () => {
      const options = getModelOptionsForProvider('openai');
      for (const opt of options) {
        expect(opt).toHaveProperty('value');
        expect(opt).toHaveProperty('label');
        expect(typeof opt.value).toBe('string');
        expect(typeof opt.label).toBe('string');
      }
    });
  });

  describe('getAiSettingsFields', () => {
    const mockConfig = {
      provider: 'anthropic',
      interactive_provider: 'anthropic',
    };

    const fields = getAiSettingsFields({
      isDeployment: false,
      getProvider: () => mockConfig.provider,
      getInteractiveProvider: () => mockConfig.interactive_provider,
    });

    test('returns an array of field definitions', () => {
      expect(Array.isArray(fields)).toBe(true);
      expect(fields.length).toBeGreaterThan(0);
    });

    test('each field has required properties', () => {
      for (const field of fields) {
        expect(field).toHaveProperty('key');
        expect(field).toHaveProperty('label');
        expect(field).toHaveProperty('type');
      }
    });

    test('includes provider and model fields', () => {
      const keys = fields.map(f => f.key);
      expect(keys).toContain('provider');
      expect(keys).toContain('model');
      expect(keys).toContain('interactive_provider');
    });

    test('dynamic-select fields have a getOptions function', () => {
      const dynamicFields = fields.filter(f => f.type === 'dynamic-select');
      expect(dynamicFields.length).toBeGreaterThan(0);
      for (const field of dynamicFields) {
        expect(typeof field.getOptions).toBe('function');
        const options = field.getOptions();
        expect(Array.isArray(options)).toBe(true);
      }
    });

    test('deployment mode includes default option', () => {
      const deployFields = getAiSettingsFields({
        isDeployment: true,
        getProvider: () => '',
        getInteractiveProvider: () => '',
      });
      const providerField = deployFields.find(f => f.key === 'provider');
      const hasDefault = providerField.options.some(o => o.value === '');
      expect(hasDefault).toBe(true);
    });
  });
});
